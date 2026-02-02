const midtransClient = require('midtrans-client');

const snap = new midtransClient.Snap({
  isProduction: false,
  serverKey: process.env.MIDTRANS_SERVER_KEY
});

async function createSnapTransaction({ orderId, amount, customer }) {
  return await snap.createTransaction({
    transaction_details: {
      order_id: orderId,
      gross_amount: amount
    },
    customer_details: {
      first_name: customer.nama,
      phone: customer.phone,
      email: customer.email || 'spmb@alazhar-bsd.sch.id'
    },
    enabled_payments: [
      'qris',
      'bca_va',
      'bni_va',
      'bri_va',
      'permata_va',
      'gopay',
      'shopeepay',
      'alfamart',
      'indomaret'
    ]
  });
}

module.exports = {
  createSnapTransaction
};
