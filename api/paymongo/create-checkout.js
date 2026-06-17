const {
  PAYMONGO_API_BASE,
  sendJson,
  getPayMongoAuthHeader,
  getOptionalEnv,
  pesosToCentavos,
  getBaseUrl,
  getSupabaseRows,
  readJsonBody,
  updateRegistration,
} = require('./_utils');

async function getServerTicket(ticketTypeId) {
  if (!ticketTypeId || !getOptionalEnv('SUPABASE_URL') || !getOptionalEnv('SUPABASE_SERVICE_ROLE_KEY')) {
    return null;
  }

  const rows = await getSupabaseRows(
    'ticket_types',
    `id=eq.${encodeURIComponent(ticketTypeId)}&select=id,name,price`
  );
  return rows[0] || null;
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return sendJson(res, 405, { error: 'Method not allowed' });
  }

  try {
    const body = await readJsonBody(req);
    const {
      registrationId,
      eventId,
      eventSlug,
      eventTitle,
      ticketTypeId,
      ticketName,
      amount,
      customerName,
      customerEmail,
      customerMobile,
    } = body;

    if (!registrationId || !ticketName || !customerName || !customerEmail) {
      return sendJson(res, 400, {
        error: 'Missing required registration, ticket, name, or email details.',
      });
    }

    // Re-read the price from the database when possible so the amount cannot be
    // tampered with from the browser. Falls back to the client-supplied amount
    // when the service role key is not configured.
    const serverTicket = await getServerTicket(ticketTypeId).catch(error => {
      console.error('Ticket price lookup failed:', error.message);
      return null;
    });

    const finalTicketName = serverTicket?.name || ticketName;
    const finalAmount = serverTicket?.price ?? amount;
    const amountCentavos = pesosToCentavos(finalAmount);
    if (amountCentavos <= 0) {
      return sendJson(res, 400, { error: 'Checkout amount must be greater than zero.' });
    }

    const baseUrl = getBaseUrl(req);
    const slugParam = eventSlug ? `&slug=${encodeURIComponent(eventSlug)}` : '';
    const ticketParam = ticketTypeId ? `&ticket=${encodeURIComponent(ticketTypeId)}` : '';
    const successUrl = process.env.PAYMENT_SUCCESS_URL
      || `${baseUrl}/registration-flow.html?payment=success&registration=${encodeURIComponent(registrationId)}${slugParam}${ticketParam}`;
    const cancelUrl = process.env.PAYMENT_FAILED_URL
      || `${baseUrl}/registration-flow.html?payment=cancelled&registration=${encodeURIComponent(registrationId)}${slugParam}${ticketParam}`;
    const paymentMethods = (process.env.PAYMONGO_PAYMENT_METHODS || 'card,gcash')
      .split(',')
      .map(method => method.trim())
      .filter(Boolean);

    const paymongoPayload = {
      data: {
        attributes: {
          billing: {
            name: customerName,
            email: customerEmail,
            phone: customerMobile || null,
          },
          description: `Registration for ${eventTitle || eventSlug || 'AYA event'}`,
          line_items: [
            {
              name: finalTicketName,
              description: eventTitle || eventSlug || 'AYA event ticket',
              amount: amountCentavos,
              currency: 'PHP',
              quantity: 1,
            },
          ],
          payment_method_types: paymentMethods,
          reference_number: String(registrationId),
          send_email_receipt: true,
          pass_on_fees: process.env.PAYMONGO_PASS_ON_FEES === 'true',
          success_url: successUrl,
          cancel_url: cancelUrl,
          metadata: {
            registration_id: String(registrationId),
            event_id: eventId ? String(eventId) : '',
            event_slug: eventSlug ? String(eventSlug) : '',
            ticket_type_id: ticketTypeId ? String(ticketTypeId) : '',
          },
        },
      },
    };

    const paymongoResponse = await fetch(`${PAYMONGO_API_BASE}/v2/checkout_sessions`, {
      method: 'POST',
      headers: {
        Authorization: getPayMongoAuthHeader(),
        'Content-Type': 'application/json',
        'Idempotency-Key': `checkout-${registrationId}`,
      },
      body: JSON.stringify(paymongoPayload),
    });

    const paymongoJson = await paymongoResponse.json();
    if (!paymongoResponse.ok) {
      return sendJson(res, paymongoResponse.status, {
        error: 'Unable to create PayMongo checkout session.',
        details: paymongoJson,
      });
    }

    const session = paymongoJson.data;
    const checkoutUrl = session?.attributes?.checkout_url;

    // Best-effort: record the checkout reference on the registration. Ignored
    // if the service role key is missing or the optional columns do not exist.
    await updateRegistration(registrationId, {
      payment_status: 'pending',
      payment_method: 'paymongo',
      payment_ref: session?.id || null,
    }).catch(error => {
      console.error('Registration checkout reference update failed:', error.message);
    });

    return sendJson(res, 200, {
      checkoutUrl,
      checkoutSessionId: session?.id,
      referenceNumber: session?.attributes?.reference_number,
    });
  } catch (error) {
    console.error(error);
    return sendJson(res, 500, { error: 'Payment setup failed. Please try again.' });
  }
};
