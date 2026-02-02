// =============================
// 💳 PAYMENT MODULE (MIDTRANS QRIS SANDBOX)
// =============================
const axios = require('axios');
const express = require('express');
const router = express.Router();

// =============================
// ⚙️ KONFIGURASI
// =============================
const MIDTRANS_API = 'https://api.sandbox.midtrans.com/v2';
const SERVER_KEY = process.env.MIDTRANS_SERVER_KEY;

// =============================
// 🔐 AUTH HEADER
// =============================
function authHeader() {
  return {
    Authorization:
      'Basic ' + Buffer.from(SERVER_KEY + ':').toString('base64'),
    'Content-Type': 'application/json'
  };
}

// =============================
// 🧾 BUAT TRANSAKSI QRIS
// =============================
async function createQrisPayment({ orderId, amount }) {
  try {
    const payload = {
      payment_type: 'qris',
      transaction_details: {
        order_id: orderId,
        gross_amount: amount
      }
    };

    const res = await axios.post(
      `${MIDTRANS_API}/charge`,
      payload,
      { headers: authHeader() }
    );

    const qrAction = res.data.actions?.find(
      a => a.name === 'generate-qr-code'
    );

    return {
      success: true,
      order_id: orderId,
      transaction_status: res.data.transaction_status,
      qr_url: qrAction?.url
    };
  } catch (err) {
    console.error('❌ QRIS ERROR:', err.response?.data || err.message);
    return { success: false, error: 'Gagal membuat QRIS' };
  }
}

// =============================
// 🔍 CEK STATUS TRANSAKSI
// =============================
async function checkPaymentStatus(orderId) {
  try {
    const res = await axios.get(
      `${MIDTRANS_API}/${orderId}/status`,
      { headers: authHeader() }
    );

    return res.data;
  } catch (err) {
    console.error('❌ STATUS ERROR:', err.message);
    return null;
  }
}

// =============================
// 🧪 SIMULASI SETTLEMENT (SANDBOX ONLY)
// =============================
async function simulateSettlement(orderId) {
  try {
    await axios.post(
      `${MIDTRANS_API}/${orderId}/settlement`,
      {},
      { headers: authHeader() }
    );
    return true;
  } catch (err) {
    console.error('❌ SETTLEMENT ERROR:', err.message);
    return false;
  }
}

// =============================
// 🌐 WEBHOOK MIDTRANS
// =============================
router.post('/midtrans/webhook', async (req, res) => {
  const notif = req.body;

  console.log('📩 MIDTRANS WEBHOOK:', notif);

  try {
    if (
      notif.transaction_status === 'settlement' ||
      notif.transaction_status === 'capture'
    ) {
      // ⚠️ UPDATE DATABASE DI INDEX.JS
      // Contoh:
      // await supabase
      //   .from('pendaftaran')
      //   .update({ status_bayar: 'paid' })
      //   .eq('id', notif.order_id);

      console.log('✅ PAYMENT SUCCESS:', notif.order_id);
    }

    res.status(200).send('OK');
  } catch (err) {
    console.error('❌ WEBHOOK ERROR:', err.message);
    res.status(500).send('ERROR');
  }
});

// =============================
// 📦 EXPORT
// =============================
module.exports = {
  createQrisPayment,
  checkPaymentStatus,
  simulateSettlement,
  paymentRouter: router
};
