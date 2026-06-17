const {
  sendJson,
  readRawBody,
  updateRegistration,
  verifyPayMongoSignature,
} = require('./_utils');

function getRegistrationId(resource) {
  const attributes = resource?.attributes || {};
  return (
    attributes.reference_number ||
    attributes.metadata?.registration_id ||
    attributes.metadata?.registrationId ||
    null
  );
}

function amountToPesos(resource) {
  const paymentAmount = resource?.attributes?.payments?.[0]?.attributes?.amount;
  const amount = paymentAmount ?? resource?.attributes?.amount;
  if (!Number.isFinite(Number(amount))) return null;
  return Number(amount) / 100;
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return sendJson(res, 405, { error: 'Method not allowed' });
  }

  const rawBody = await readRawBody(req);
  const signature = req.headers['paymongo-signature'] || req.headers['x-paymongo-signature'];

  if (!verifyPayMongoSignature(rawBody, signature)) {
    return sendJson(res, 401, { error: 'Invalid PayMongo signature' });
  }

  let payload;
  try {
    payload = JSON.parse(rawBody.toString('utf8'));
  } catch (error) {
    return sendJson(res, 400, { error: 'Invalid JSON payload' });
  }

  const eventType = payload?.data?.type || payload?.data?.attributes?.type;
  const resource = payload?.data?.data || payload?.data?.attributes?.data;
  const registrationId = getRegistrationId(resource);

  try {
    if (eventType === 'checkout_session.payment.paid' || eventType === 'payment.paid') {
      // 'confirmed' matches the status the rest of the app counts as a paid,
      // capacity-consuming registration (see event-detail.html / admin dashboard).
      const paidFields = {
        payment_status: 'confirmed',
        payment_method: 'paymongo',
      };
      const paidAmount = amountToPesos(resource);
      if (paidAmount != null) paidFields.amount_paid = paidAmount;
      const payMongoRef = resource?.attributes?.payments?.[0]?.id || resource?.id || null;
      if (payMongoRef) paidFields.payment_ref = payMongoRef;
      await updateRegistration(registrationId, paidFields);
    } else if (
      eventType === 'checkout_session.payment.failed' ||
      eventType === 'payment.failed' ||
      eventType === 'checkout_session.expired'
    ) {
      await updateRegistration(registrationId, {
        payment_status: 'cancelled',
        payment_method: 'paymongo',
      });
    }

    return sendJson(res, 200, { received: true });
  } catch (error) {
    console.error(error);
    return sendJson(res, 500, { error: 'Webhook received but registration update failed.' });
  }
};
