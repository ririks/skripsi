// =============================
// Import Modul
// =============================
const wppconnect = require('@wppconnect-team/wppconnect');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const qs = require('qs');
const PDFDocument = require('pdfkit');
//const app = require('../spmb/api/server');
const express = require('express');
const cors = require('cors');
const QR_PATH = path.join(__dirname, 'qr.png');
const server = express();
let lastQR = null;   

server.use(express.json());
server.use(express.urlencoded({ extended: true }));
server.use(cors({
  origin: '*', // dev mode
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type'],
}));
server.get('/qr', (req, res) => {
  if (!lastQR) {
    return res.send('<h2>Menunggu QR...</h2>');
  }

  res.send(`
    <h2>Scan QR WhatsApp</h2>
    <pre style="
      font-size:8px;
      line-height:8px;
      font-family:monospace;
      background:#fff;
      padding:10px;
      display:inline-block;
    ">
${lastQR}
    </pre>
    <p>Scan menggunakan WhatsApp → Perangkat Tertaut</p>
  `);
});


const open = require('open');
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
console.log('SUPABASE URL:', process.env.SUPABASE_URL);
console.log('SERVICE KEY LENGTH:', process.env.SUPABASE_SERVICE_KEY?.length);
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY // WAJIB service key
);
const {
  paymentRouter
} = require('./payment');
const midtransClient = require('midtrans-client');
const { createSnapTransaction } = require('./midtrans');
// =============================
// ⚙️ Konfigurasi & Variabel
// =============================
async function getMenuConfig(role = 'guest') {
  const { data, error } = await supabase
    .from('menus')
    .select('menu_key, title, description')
    .eq('role', role)
    .eq('is_active', true)
    .is('parent_key', null)
    .order('urutan');

  if (error) {
    console.error('Menu error:', error.message);
    return [];
  }

  return data;
}

const PDF_FOLDER = path.join(__dirname, 'pdf');
if (!fs.existsSync(PDF_FOLDER)) fs.mkdirSync(PDF_FOLDER);
const loggedInUsers = new Map(); 
const paymentSessions = new Map();
// key: whatsapp, value: { username, nama, jenjang }
const sessions = new Map();     // sesi input user
const humanMode = new Set();    // mode komunikasi manual
const lastReplyTime = new Map();// waktu terakhir user balas
const greetedUsers = new Set(); // untuk user yang sudah disapa
const lanjutanSessions = new Map();
const paymentTimeouts = new Map();
// key: whatsapp
// value: { no_pendaftaran }

    
// =============================
// Jalankan Bot
// =============================
let globalClient = null;
const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
// =============================
// MIDTRANS WEBHOOK
// =============================
server.post('/midtrans/webhook', async (req, res) => {
  try {
    console.log('📥 MIDTRANS WEBHOOK:', req.body);

    const notif = req.body;

    // ABAIKAN STATUS GAGAL
    if (!['settlement', 'capture'].includes(notif.transaction_status)) {
      return res.status(200).send('IGNORED');
    }

    // Ambil pembayaran
    const { data: bayar } = await supabase
      .from('pembayaran')
      .select('*')
      .eq('order_id', notif.order_id)
      .maybeSingle();

    if (!bayar) {
      console.warn('⏳ Pembayaran belum ada, tunggu retry:', notif.order_id);
      return res.status(200).send('OK');
    }
    if (paymentTimeouts.has(bayar.whatsapp)) {
      clearTimeout(paymentTimeouts.get(bayar.whatsapp));
      paymentTimeouts.delete(bayar.whatsapp);
    }
    
    paymentSessions.delete(bayar.whatsapp);
    const noPendaftaran = bayar.no_pendaftaran;
    // Update status pembayaran
    await supabase
      .from('pembayaran')
      .update({
        transaction_status: 'paid',
        payment_type: notif.payment_type,
        settlement_time: notif.settlement_time
      })
      .eq('order_id', notif.order_id);

    // 3️⃣ Ambil data pendaftaran
    const { data: daftar } = await supabase
      .from('pendaftaran')
      .select('*')
      .eq('no_pendaftaran', bayar.no_pendaftaran)
      .single();

    if (!daftar) {
      console.warn('⚠️ Pendaftaran tidak ditemukan:', bayar.no_pendaftaran);
      return res.status(200).send('OK');
    
    }

// =============================
// GENERATE AKUN LOGIN
// =============================
const username = noPendaftaran;
const password = generatePassword();

await supabase.from('akun_login').insert({
  username,
  password,
  nama: daftar.nama,
  jenjang: daftar.jenjang,
  whatsapp: daftar.whatsapp
});

// =============================
// GENERATE PDF
// =============================

const pdfPath = path.join(PDF_FOLDER, `${noPendaftaran}.pdf`);
const doc = new PDFDocument({ margin: 50 });
const stream = fs.createWriteStream(pdfPath);

doc.pipe(stream);

// ===== JUDUL =====
doc
  .fontSize(16)
  .font('Helvetica-Bold')
  .text('BUKTI PENDAFTARAN SPMB 2025', { align: 'center' });

doc.moveDown(1.5);

// helper sejajar
const labelX = 50;
const valueX = 200;
const lineGap = 18;

function row(label, value) {
  doc.font('Helvetica-Bold')
     .text(label, labelX, doc.y, { width: 140 });

  doc.font('Helvetica')
     .text(`: ${value || '-'}`, valueX, doc.y - lineGap, { width: 320 });

  doc.moveDown();
}

// =============================
// A. DATA PENDAFTARAN
// =============================
doc.fontSize(12).font('Helvetica-Bold').text('A. DATA PENDAFTARAN');
doc.moveDown(0.5);
doc.font('Helvetica');

row('Nomor Pendaftaran', noPendaftaran);
row('Jenis Pendaftaran', daftar.jenis_pendaftaran || 'Peserta Didik Baru');
row('Jenjang', daftar.jenjang);

// =============================
// B. DATA PESERTA DIDIK
// =============================
doc.moveDown();
doc.font('Helvetica-Bold').text('B. DATA PESERTA DIDIK');
doc.moveDown(0.5);
doc.font('Helvetica');

row('Nama Murid', daftar.nama);
row('Jenis Kelamin', daftar.jenis_kelamin);
row('Tempat Lahir', daftar.tempat_lahir);
row('Tanggal Lahir', daftar.tanggal_lahir);

// =============================
// C. DATA KONTAK
// =============================
doc.moveDown();
doc.font('Helvetica-Bold').text('C. DATA KONTAK');
doc.moveDown(0.5);
doc.font('Helvetica');

row('No. Telp Rumah', daftar.no_telp || '-');
row('No. HP Utama', daftar.no_hp1);
row('No. HP Cadangan', daftar.no_hp2 || '-');
row('Email', daftar.email);

// =============================
// D. AKUN LOGIN
// =============================
doc.moveDown();
doc.font('Helvetica-Bold').text('D. AKUN LOGIN SPMB');
doc.moveDown(0.5);
doc.font('Helvetica');

row('Username', username);
row('Password', password);

// =============================
// FOOTER
// =============================
doc.moveDown(2);
doc
  .fontSize(10)
  .text(
    'Dokumen ini merupakan bukti resmi pendaftaran SPMB dan dihasilkan secara otomatis oleh sistem.',
    { align: 'center' }
  );

doc.end();
await new Promise(r => stream.on('finish', r));


// =============================
// 📲 KIRIM PDF KE WHATSAPP
// =============================
if (globalClient) {
  const waTarget = bayar.wa_target;

  try {
    await globalClient.sendFile(
      waTarget,
      pdfPath,
      `${noPendaftaran}.pdf`,
      `✅ *Pembayaran Berhasil*

🆔 Order ID: *${notif.order_id}*
👤 Nama: ${daftar.nama}

🔐 *Akun Login*
Username: *${username}*
Password: *${password}*

📄 Bukti pendaftaran terlampir`
    );

    await globalClient.sendText(
      formatWA(waTarget),
      '✍️ Ketik *kembali* untuk kembali ke menu.'
    );

  } catch (waErr) {
    console.error('❌ GAGAL KIRIM WA:', waErr.message);
  }
}



    res.status(200).send('OK');
  } catch (err) {
    console.error('❌ WEBHOOK ERROR:', err);
    res.status(500).send('ERROR');
  }
});

server.use(paymentRouter);

server.post('/send-message', async (req, res) => {
  const { to, message } = req.body;

  console.log('📨 BROADCAST MASUK:', to, message);

  if (!globalClient) {
    return res.status(500).json({
      status: 'error',
      msg: 'WhatsApp belum siap'
    });
  }

  try {
    for (const number of to) {
      const wa = formatWA(number);
      await globalClient.sendText(wa, message);
      await new Promise(r => setTimeout(r, 1000));
    }

    res.json({ status: 'success' });
  } catch (err) {
    console.error('❌ ERROR BROADCAST:', err);
    res.status(500).json({ status: 'error', msg: err.message });
  }
});



function formatWA(number) {
  if (!number) return null;

  let n = number.toString();

  // kalau sudah format WhatsApp
  if (n.includes('@c.us')) return n;

  n = n.replace(/\D/g, '');

  if (n.startsWith('0')) {
    n = '62' + n.slice(1);
  }

  if (!n.startsWith('62')) {
    n = '62' + n;
  }

  return `${n}@c.us`;
}

//const QRCode = require('qrcode');

wppconnect.create({
  session: 'ppdbBotv2',
  headless: true,
  autoClose: false,
  waitForLogin: false,

  puppeteerOptions: {
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu'
    ]
  },

  catchQR: (qrCode, asciiQR) => {
    lastQR = asciiQR;
    console.log('✅ ASCII QR siap');
  },
  

  statusFind: (status) => {
    console.log('📡 STATUS SESSION:', status);
  }
})
.then(client => {
  globalClient = client;
  start(client);
})
.catch(console.error);




function getKelompokJenjang(kodeJenjang) {
  // Toddler, Playgroup, TK, SD
  if (['13','14','15','16','01'].includes(kodeJenjang)) {
    return 'sd_toddler';
  }

  // SMP & SMA
  if (['07','10'].includes(kodeJenjang)) {
    return 'smp_sma';
  }

  return null;
}

// =============================
// Login
// =============================
function generatePassword(length = 6) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  let pass = '';
  for (let i = 0; i < length; i++) {
    pass += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return pass;
}

async function simpanLogin(username, password, data) {
  const { data: res, error } = await supabase
    .from('akun_login')
    .insert({
      username: username.trim(),
      password: password.trim(),
      nama: data.nama,
      jenjang: data.jenjang,
      //whatsapp: data.whatsapp_from
    })
    .select();

  if (error) {
    console.error('❌ GAGAL SIMPAN LOGIN:', error.message);
    throw error;
  }

  console.log('✅ LOGIN TERSIMPAN:', res);
}

async function cekLogin(username, password) {
  const { data, error } = await supabase
    .from('akun_login')
    .select('username, nama, jenjang')
    .eq('username', username.trim())
    .eq('password', password.trim())
    .order('id', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    console.error('❌ CEK LOGIN ERROR:', error.message);
    return null;
  }

  return data;
}


async function getSubMenu(parentKey, role = 'guest') {
  const { data, error } = await supabase
    .from('menus')
    .select('menu_key, title, description')
    .eq('parent_key', parentKey)
    .eq('role', role)
    .eq('is_active', true)
    .order('urutan');

  if (error) {
    console.error('❌ ERROR getSubMenu:', error.message);
    return [];
  }
  return data;
}

async function kirimMenuDynamic(client, to, parentKey, title) {
  const rows = await getSubMenu(parentKey);

  if (!rows.length) {
    await client.sendText(to, '⚠️ Menu belum tersedia');
    return;
  }

  await client.sendListMessage(to, {
    title,
    description: 'Silakan pilih',
    buttonText: 'Pilih',
    sections: [{
      title: 'Menu',
      rows: rows.map(r => ({
        rowId: r.menu_key,
        title: r.title,
        description: r.description || ''
      }))
    }]
  });
}

async function generateNoPendaftaran(jenjang) {
  const prefix = getPrefixByJenjang(jenjang);

  const { data, error } = await supabase
    .from('pendaftaran')
    .select('no_pendaftaran')
    .ilike('no_pendaftaran', `${prefix}%`)
    .order('no_pendaftaran', { ascending: false })
    .limit(1);

  if (error) {
    console.error('❌ ERROR generate no pendaftaran:', error.message);
    throw error;
  }

  // Jika belum ada sama sekali
  if (!data || data.length === 0) {
    return `${prefix}0001`;
  }

  // Ambil 4 digit terakhir, tambah 1
  const lastNumber = parseInt(data[0].no_pendaftaran.slice(-4));
  const nextNumber = String(lastNumber + 1).padStart(4, '0');

  return `${prefix}${nextNumber}`;
}


async function getInfoUmum(key) {
  const { data } = await supabase
    .from('info_umum')
    .select('title, content')
    .eq('key', key)
    .eq('is_active', true)
    .maybeSingle();

  return data;
}

async function getInfoSPMB(key) {
  const { data } = await supabase
    .from('info_spmb')
    .select('title, content')
    .eq('key', key)
    .eq('is_active', true)
    .maybeSingle();

  return data;
}

// =============================
// 🎯 Kuota Pendaftaran 
// =============================
async function getKuotaDashboard() {
  const { data, error } = await supabase
    .from('kuota')
    .select('jenjang, batas');

  if (error || !data) {
    console.error('❌ ERROR ambil kuota:', error?.message);
    return {};
  }

  return Object.fromEntries(
    data.map(k => [
      k.jenjang.toLowerCase().trim(),
      k.batas
    ])
  );
}

// =============================
// 📬 Fungsi utama
// =============================
async function start(client) {
  client.onMessage(async (message) => {
    try {
      const waUser = getUserWA(message);
      const textMsg = (message.body || "").toLowerCase();
// =============================
// 🔒 MODE PEMBAYARAN AKTIF
// =============================
if (paymentSessions.has(from) && textMsg !== 'batal') {
  await client.sendText(
    from,
`⏳ *Pembayaran Masih Menunggu*

Silakan:
• 💳 Selesaikan pembayaran melalui link
• ❌ Ketik *batal* untuk membatalkan

(Pendaftaran akan dibatalkan otomatis jika melebihi 30 menit)`
  );
  return;
}

// =============================
// ❌ BATAL PEMBAYARAN 
// =============================
if (textMsg === 'batal' && paymentSessions.has(from)) {

  // 🛑 hentikan timer
  if (paymentTimeouts.has(from)) {
    clearTimeout(paymentTimeouts.get(from));
    paymentTimeouts.delete(from);
  }

  const session = paymentSessions.get(from);
  if (!session) {
    console.warn('⚠️ paymentSession kosong saat batal:', from);
    return;
  }

  const { orderId, no_pendaftaran } = session;

  // 1️⃣ HAPUS DATA PEMBAYARAN
  await supabase
    .from('pembayaran')
    .delete()
    .eq('order_id', orderId);

  // 2️⃣ HAPUS DATA PENDAFTARAN
  await supabase
    .from('pendaftaran')
    .delete()
    .eq('no_pendaftaran', no_pendaftaran);

  // 3️⃣ BERSIHKAN SESSION
  paymentSessions.delete(from);
  sessions.delete(from);

  await client.sendText(
    from,
`❌ *Pembayaran Dibatalkan*

Data pendaftaran *tidak disimpan*
karena pembayaran tidak dilanjutkan.

✍️ Ketik *SPMB* untuk kembali ke menu.`
  );

  return; // ⛔ STOP DI SINI
}


// =============================
// HANDLE KETIK "KEMBALI"
// =============================
if (textMsg === 'kembali') {
  // kalau sudah login → menu login
  if (loggedInUsers.has(from)) {
    await kirimMenuLogin(client, from);
  } 
  // kalau belum login → menu utama
  else {
    await kirimMenuUtama(client, from);
  }

  // reset session apapun
  sessions.delete(from);
  lanjutanSessions.delete(from);
  return;
}
      if (sessions.has(from) && sessions.get(from).mode === 'login') {
  const rawText = message.body || '';

  const u = rawText.match(/username\s*:\s*(.+)/i);
  const p = rawText.match(/password\s*:\s*(.+)/i);

  if (!u || !p) {
    await client.sendText(
      from,
      '⚠️ Format login salah.\n\nGunakan:\nusername: xxx\npassword: xxx'
    );
    return;
  }

  const username = u[1].trim();
  const password = p[1].trim();

  console.log('🔐 LOGIN TRY:', username, password);

  const user = await cekLogin(username, password);

  if (!user) {
    await client.sendText(
      from,
  `❌ *Login Gagal*
  
  Username atau password salah.
  
  ✍️ Silakan:
  • Kirim ulang *username* dan *password*
  • Atau ketik *kembali* untuk kembali ke menu`
    );
    return;
  }
  


  loggedInUsers.set(waUser, {
    username: user.username,
    nama: user.nama,
    jenjang: user.jenjang
  });

  await client.sendText(
    from,
    `✅ *Login Berhasil!*\n
👤 Nama: ${user.nama}
📚 Jenjang: ${user.jenjang}`
  );

  sessions.delete(from);
  await kirimMenuLogin(client, from);
  return;
}
            // Jika sedang human mode (chat manual)
            if (humanMode.has(from)) {
              lastReplyTime.set(from, Date.now());
              if (textMsg === "ppdb") {
                humanMode.delete(from);
                lastReplyTime.delete(from);
                await kirimMenu(client, from);
              }
              return;
            }
// =============================
// HANDLE FORM PENDAFTARAN LANJUTAN
// =============================
if (lanjutanSessions.has(from)) {
  const text = (message.body || '').trim();

  if (text.toLowerCase() === 'batal') {
    lanjutanSessions.delete(from);
    await client.sendText(from, '✖️ Pendaftaran lanjutan dibatalkan.');
    await kirimMenuLogin(client, from);
    return;
  }

  const data = parseFormLanjutan(text);
  // 🔴 CEK FIELD WAJIB
const missingFields = getMissingLanjutanFields(data);

if (missingFields.length > 0) {
  await client.sendText(
    from,
`⚠️ *Data Pendaftaran Lanjutan Belum Lengkap*

Field berikut *WAJIB diisi*:
• ${missingFields.join('\n• ')}

✍️ Silakan *isi ulang SEMUA data* dalam *SATU PESAN*
atau ketik *batal* untuk membatalkan.`
  );
  return; // ⛔ JANGAN LANJUT INSERT
}

// =============================
// 📞 VALIDASI NO HP ORANG TUA
// =============================
if (!isNumericPhone(data.no_hp_ayah)) {
  await client.sendText(
    from,
`⚠️ *No HP Ayah Tidak Valid*

No HP Ayah *harus berupa angka saja*.
Contoh: 081234567890

✍️ Silakan *isi ulang seluruh data*
dalam *SATU PESAN* atau ketik *batal*.`
  );
  return;
}

if (!isNumericPhone(data.no_hp_ibu)) {
  await client.sendText(
    from,
`⚠️ *No HP Ibu Tidak Valid*

No HP Ibu *harus berupa angka saja*.
Contoh: 081234567890

✍️ Silakan *isi ulang seluruh data*
dalam *SATU PESAN* atau ketik *batal*.`
  );
  return;
}

const { no_pendaftaran } = lanjutanSessions.get(from);

    // =============================
// 1️⃣ SIMPAN DATA LANJUTAN
// =============================

const cleanedData = normalizeLanjutanData(data);

const { error: lanjutanErr } = await supabase
  .from('pendaftaran_lanjutan')
  .insert({
    no_pendaftaran,
    ...cleanedData,
    status: 'submitted'
  });

if (lanjutanErr) {
  console.error('❌ INSERT LANJUTAN GAGAL:', lanjutanErr.message);
  await client.sendText(
    from,
    '❌ Gagal menyimpan pendaftaran lanjutan. Silakan coba kembali.'
  );
  return;
}


if (lanjutanErr) {
  console.error('❌ INSERT LANJUTAN GAGAL:', lanjutanErr.message);
  await client.sendText(
    from,
    '❌ Gagal menyimpan pendaftaran lanjutan. Silakan coba kembali.'
  );
  return;
}


// =============================
// 2️⃣ AMBIL DATA PENDAFTARAN UTAMA
// =============================
const { data: utama } = await supabase
  .from('pendaftaran')
  .select('*')
  .eq('no_pendaftaran', no_pendaftaran)
  .single();

if (!utama) {
  await client.sendText(from, '❌ Data pendaftaran utama tidak ditemukan.');
  return;
}
// =============================
// 3️⃣ GENERATE PDF LANJUTAN
// =============================
// =============================
// 3️⃣ GENERATE PDF LANJUTAN (RAPI)
// =============================
const pdfPath = path.join(PDF_FOLDER, `${no_pendaftaran}_lanjutan.pdf`);
const doc = new PDFDocument({ margin: 50 });
const stream = fs.createWriteStream(pdfPath);

doc.pipe(stream);

// ===== JUDUL =====
doc
  .fontSize(16)
  .font('Helvetica-Bold')
  .text('FORMULIR PENDAFTARAN LANJUTAN', { align: 'center' });

doc.moveDown(1.5);

// helper biar sejajar
const labelX = 50;
const valueX = 200;
const lineGap = 18;

function row(label, value) {
  doc
    .font('Helvetica-Bold')
    .text(label, labelX, doc.y, { width: 140 });
  doc
    .font('Helvetica')
    .text(`: ${value || '-'}`, valueX, doc.y - lineGap, { width: 300 });
  doc.moveDown();
}

// ===== DATA PESERTA =====
doc.fontSize(12).font('Helvetica-Bold').text('A. DATA PESERTA');
doc.moveDown(0.5);
doc.font('Helvetica');

row('Nomor Pendaftaran', no_pendaftaran);
row('Nama Murid', utama.nama);
row('Jenjang', utama.jenjang);

doc.moveDown();

// ===== DATA AYAH =====
doc.font('Helvetica-Bold').text('B. DATA AYAH');
doc.moveDown(0.5);
doc.font('Helvetica');

row('Nama Ayah', data.nama_ayah);
row('Pekerjaan Ayah', data.pekerjaan_ayah);
row('Pendidikan Ayah', data.pendidikan_ayah);
row('No HP Ayah', data.no_hp_ayah);

doc.moveDown();

// ===== DATA IBU =====
doc.font('Helvetica-Bold').text('C. DATA IBU');
doc.moveDown(0.5);
doc.font('Helvetica');

row('Nama Ibu', data.nama_ibu);
row('Pekerjaan Ibu', data.pekerjaan_ibu);
row('Pendidikan Ibu', data.pendidikan_ibu);
row('No HP Ibu', data.no_hp_ibu);

doc.moveDown();

// ===== ALAMAT =====
doc.font('Helvetica-Bold').text('D. DATA ALAMAT');
doc.moveDown(0.5);
doc.font('Helvetica');

row('Alamat Lengkap', data.alamat);
row('Kelurahan', data.kelurahan);
row('Kecamatan', data.kecamatan);
row('Kota', data.kota);
row('Provinsi', data.provinsi);
row('Kode Pos', data.kode_pos);

doc.moveDown();

// ===== DATA TAMBAHAN =====
doc.font('Helvetica-Bold').text('E. DATA TAMBAHAN');
doc.moveDown(0.5);
doc.font('Helvetica');

row('Anak Ke', data.anak_ke);
row('Jumlah Saudara', data.jumlah_saudara);
row('Penghasilan Orang Tua', data.penghasilan_orangtua);
row(
  'Kebutuhan Khusus',
  data.kebutuhan_khusus?.toLowerCase().includes('ya') ? 'Ya' : 'Tidak'
);
row('Keterangan Khusus', data.keterangan_khusus || '-');

// ===== FOOTER =====
doc.moveDown(2);
doc
  .fontSize(10)
  .text(
    'Dokumen ini dihasilkan secara otomatis oleh Sistem Pendaftaran SPMB.',
    { align: 'center' }
  );

doc.end();

await new Promise(r => stream.on('finish', r));


// =============================
// 4️⃣ KIRIM PDF KE WHATSAPP
// =============================
await client.sendFile(
  from,
  pdfPath,
  `${no_pendaftaran}_lanjutan.pdf`,
  `✅ *Pendaftaran Lanjutan Berhasil*

Data orang tua & alamat telah diterima.
📄 Bukti pendaftaran lanjutan terlampir.`
);

// =============================
// 5️⃣ BERSIHKAN SESSION
// =============================
lanjutanSessions.delete(from);
await kirimMenuLogin(client, from);
return; // 🔴 WAJIB
}
            // Ambil pilihan menu
            let selected = null;
            if (message.type === 'list_response' && message.listResponse)
              selected = message.listResponse.singleSelectReply.selectedRowId;
            else if (message.selectedRowId)
              selected = message.selectedRowId;
            else if (message.type === 'buttons_response')
              selected = message.selectedButtonId;
      
            // Jika user sedang isi form
            if (sessions.has(from)) {
              if (selected && selected !== 'daftar') {
                sessions.delete(from);
              } else {
                await handleCombinedForm(client, message, from);
                return;
              }
            }

            // Proses menu utama
            if (selected) {
              const infoUmum = await getInfoUmum(selected);
if (infoUmum) {
  await client.sendText(
    from,
    `📌 *${infoUmum.title}*\n\n${infoUmum.content}`
  );
  await client.sendText(
    from,
    `✍️ Ketik *kembali* untuk kembali ke menu.`
  );  
  return;
}

const infoSPMB = await getInfoSPMB(selected);
// ⛔ JANGAN treat "daftar" sebagai info
if (
  !['daftar', 'syarat', 'kuota', 'jadwal'].includes(selected) &&
  !selected.startsWith('syarat_')
) {
  const infoSPMB = await getInfoSPMB(selected);
  if (infoSPMB) {

    await client.sendText(
      from,
      `🎓 *${infoSPMB.title}*\n\n${infoSPMB.content}`
    );

    // 🔐 LOGIN
    if (selected === 'login') {
      sessions.set(waUser, { mode: 'login' });
      await client.sendText(
        from,
`🔐 *Masuk Akun SPMB*

Ketik dengan format:
username: xxx
password: xxx

✍️ Ketik *kembali* untuk kembali ke menu.`
      );
      return;
    }
  return;
}
}
// =============================
// 📋 SYARAT PENDAFTARAN PER JENJANG
// =============================
if (selected && selected.startsWith('syarat_')) {
  const info = await getInfoSPMB(selected);

  if (!info) {
    await client.sendText(
      from,
      '⚠️ Syarat pendaftaran belum tersedia untuk jenjang ini.'
    );
    await client.sendText(
      from,
      '✍️ Ketik *kembali* untuk kembali ke menu.'
    );
    
    return;
  }

  await client.sendText(
    from,
    `📋 *${info.title}*\n\n${info.content}`
  );

  await client.sendText(
    from,
    `✍️ Ketik *kembali* untuk kembali ke menu.`
  );
  
  return;
}

              switch (selected) {
                case 'info_umum':
  await kirimMenuDynamic(client, from, 'info_umum', '📌 Informasi Umum');
  break;

case 'spmb':
  await kirimMenuDynamic(client, from, 'spmb', '🎓 SPMB');
  break;

    case 'lowongan':
    case 'alamat':
    case 'kontak_umum': 
    case 'jam':{
      const info = await getInfoUmum(selected);
    
      if (!info) {
        await client.sendText(
          from,
          '⚠️ Informasi belum tersedia.'
        );
        await client.sendText(
          from,
          '✍️ Ketik *kembali* untuk kembali ke menu.'
        );        
        break;
      }
    
      await client.sendText(
        from,
        `📌 *${info.title}*\n\n${info.content}`
      );
    
      await client.sendText(
        from,
        `✍️ Ketik *kembali* untuk kembali ke menu.`
      );
      
      break;
    }    
        case 'daftar':
          await kirimFormDariTemplate(client, from);
          break;
        
          case 'jadwal': {
            const info = await getInfoSPMB('jadwal');
          
            if (!info) {
              await client.sendText(
                from,
                '⚠️ Jadwal pendaftaran belum tersedia.'
              );
              await client.sendText(
                from,
                `✍️ Ketik *kembali* untuk kembali ke menu.`
              );
              
              break;
            }
          
            await client.sendText(
              from,
              `📅 *${info.title}*\n\n${info.content}`
            );
          
            await client.sendText(
              from,
              `✍️ Ketik *kembali* untuk kembali ke menu.`
            );
            
            break;
          }                  
                    case 'syarat':
  await client.sendListMessage(from, {
    title: '📋 Syarat Pendaftaran',
    description: 'Pilih jenjang yang ingin dilihat',
    buttonText: 'Pilih Jenjang',
    sections: [
      {
        title: 'Jenjang',
        rows: [
          { rowId: 'syarat_toddler', title: 'Toddler' },
          { rowId: 'syarat_tk', title: 'TK (TA / A / B)' },
          { rowId: 'syarat_sd', title: 'SD' },
          { rowId: 'syarat_smp', title: 'SMP' },
          { rowId: 'syarat_sma', title: 'SMA' }
        ]
      }
    ]
  });
  break;
  await client.sendText(
    from,
    `✍️ Ketik *kembali* untuk kembali ke menu.`
  );
    
                      break;             
                      case 'kuota': {
                        // 1️⃣ Ambil narasi dari info_spmb
                        const info = await getInfoSPMB('kuota');
                      
                        // 2️⃣ Ambil data kuota
                        const kuotaDashboard = await getKuotaDashboard();
                      
                        if (!Object.keys(kuotaDashboard).length) {
                          await client.sendText(from, '⚠️ Data kuota belum tersedia.');
                          await client.sendText(
                            from,
                            '✍️ Ketik *kembali* untuk kembali ke menu.'
                          );
                          
                          break;
                        }
                      
                        let pesan = '';
                      
                        if (info) {
                          pesan += `📊 *${info.title}*\n\n${info.content}\n\n`;
                        } else {
                          pesan += '📊 *Kuota Pendaftaran SPMB*\n\n';
                        }
                      
                        // 3️⃣ Loop tiap jenjang
                        for (const [jenjangKey, batas] of Object.entries(kuotaDashboard)) {
                          const jenjangLabel =
                            jenjangKey.replace(/\b\w/g, c => c.toUpperCase());
                      
                          const { count } = await supabase
                            .from('pendaftaran')
                            .select('*', { count: 'exact', head: true })
                            .ilike('jenjang', jenjangKey);
                      
                          const terdaftar = count || 0;
                          const sisa = Math.max(0, batas - terdaftar);
                      
                          pesan += `🏫 *${jenjangLabel}*\n`;
                          pesan += `• Kuota: ${batas}\n`;
                          pesan += `• Terdaftar: ${terdaftar}\n`;
                          pesan += `• Sisa: ${sisa}\n\n`;
                        }
                      
                        await client.sendText(from, pesan);
                        await client.sendText(
                          from,
                          `✍️ Ketik *kembali* untuk kembali ke menu.`
                        );
                        
                        break;
                      }
                                 
                      case 'konfirmasi_bayar': {
                        if (!paymentSessions.has(from)) {
                          await client.sendText(from, '⚠️ Tidak ada transaksi aktif.');
                          return;
                        }
                      
                        const { orderId, data } = paymentSessions.get(from);
                      
                        // SIMULASI SETTLEMENT MIDTRANS
                        await simulateSettlement(orderId);
                      
                        // ===== UPDATE PEMBAYARAN =====
                        await supabase
  .from('pembayaran')
  .update({
    transaction_status: 'paid',
    payment_type: notif.payment_type,
    settlement_time: new Date()
  })
  .eq('order_id', notif.order_id);


                      
                        // ===== GENERATE AKUN =====
                        const { no_pendaftaran } = paymentSessions.get(from);
                        const username = no_pendaftaran;
const password = generatePassword();

await simpanLogin(username, password, data);
                      
                        // ===== GENERATE PDF =====
                        const pdfPath = path.join(PDF_FOLDER, `${orderId}.pdf`);
                        const doc = new PDFDocument({ margin: 50 });
                        const writeStream = fs.createWriteStream(pdfPath);
                        doc.pipe(writeStream);
                      
                        doc.fontSize(18).text('Formulir Pendaftaran SPMB 2025', { align: 'center' });
                        doc.moveDown();
                        doc.text(`Username: ${username}`);
                        doc.text(`Password: ${password}`);
                        doc.text(`Nomor Pendaftaran: ${orderId}`);
                        doc.text(`Nama: ${data.nama}`);
                        doc.text(`Jenjang: ${data.jenjang}`);
                        doc.end();
                      
                        await new Promise(r => writeStream.on('finish', r));
                      
                        await client.sendFile(
                          from,
                          pdfPath,
                          `${orderId}.pdf`,
                          `✅ *Pembayaran Berhasil!*
                      
                      🆔 Nomor Pendaftaran: *${orderId}*
                      👤 Nama: ${data.nama}
                      
                      🔐 *Akun Login*
                      Username: *${username}*
                      Password: *${password}*`
                        );
                        await client.sendText(
                          from,
                          '✍️ Ketik *kembali* untuk kembali ke menu.'
                        );
                        paymentSessions.delete(from);
                        break;
                      }                      
                case 'kontak':
                  await client.sendListMessage(from, {
                    buttonText: 'Hubungi Panitia',
                    description: '☎️ Apakah Anda ingin menghubungi panitia SPMB?',
                    sections: [
                      {
                        title: 'Pilihan',
                        rows: [
                          { rowId: 'hubungi_panitia', title: 'Ya' },
                          { rowId: 'back', title: 'Tidak' }
                        ]
                      }
                    ],
                    title: 'Kontak Panitia SPMB',
                    footer: 'Pilih salah satu'
                  });
                  break;
                  case 'login':
                    sessions.set(waUser, { mode: 'login' });

                    await client.sendText(from, 
                    `🔐 *Login SPMB*
                    
                    Login ini hanya untuk peserta
                    yang telah menyelesaikan pembayaran.
                    
                    📌 Akun dikirim otomatis via WhatsApp
                    setelah pembayaran berhasil.
                    
                    Ketik dengan format:
                    username: xxx
                    password: xxx`
                    );  
                    break;                  
                case 'hubungi_panitia':
                  humanMode.add(from);
                  lastReplyTime.set(from, Date.now());
                  await client.sendText(from, '✅ Anda sudah terhubung dengan *Panitia SPMB*.\n\nSilakan tunggu, panitia akan segera menghubungi Anda.');
                  return;
                  case 'lanjutan': {
                    if (!loggedInUsers.has(from)) {
                      await client.sendText(from, '⚠️ Silakan login terlebih dahulu.');
                      return;
                    }
                  
                    // ✅ AMBIL USER LOGIN DULU
                    const userLogin = loggedInUsers.get(from);
                  
                    // ✅ CEK SUDAH LANJUTAN ATAU BELUM
                    const { data: sudahLanjutan, error } = await supabase
                      .from('pendaftaran_lanjutan')
                      .select('id')
                      .eq('no_pendaftaran', userLogin.username)
                      .limit(1);
                  
                    if (error) {
                      console.error('❌ CEK LANJUTAN ERROR:', error.message);
                      await client.sendText(from, '❌ Terjadi kesalahan sistem.');
                      return;
                    }
                  
                    if (sudahLanjutan && sudahLanjutan.length > 0) {
                      await client.sendText(
                        from,
                  `⚠️ *Pendaftaran Lanjutan Sudah Pernah Diisi*
                  
                  Setiap akun hanya dapat digunakan untuk *1 peserta didik*.
                  
                  Jika ingin mendaftarkan *anak lain*,
                  silakan lakukan *pendaftaran baru* dari menu *Daftar*.`
                      );
                      return;
                    }
                  
                    // ✅ BARU SET SESSION
                    lanjutanSessions.set(waUser, {
                      no_pendaftaran: userLogin.username
                    });
                  
                    await client.sendText(
                      from,
                  `🧾 *Formulir Pendaftaran Lanjutan*
                  
                  Silakan isi data berikut dalam *SATU PESAN* seperti contoh:
                  
Silakan isi data berikut dalam *SATU PESAN* seperti contoh:

1. Nama Ayah:
2. Pekerjaan Ayah:
3. Pendidikan Ayah:
4. No HP Ayah:
5. Nama Ibu:
6. Pekerjaan Ibu:
7. Pendidikan Ibu:
8. No HP Ibu:
9. Alamat Lengkap:
10. Kelurahan:
11. Kecamatan:
12. Kota:
13. Provinsi:
14. Kode Pos:
15. Anak Ke:
16. Jumlah Saudara:
17. Penghasilan Orang Tua:
18. Kebutuhan Khusus (ya/tidak):
19. Keterangan Khusus:
ketik *batal* untuk membatalkan.`
                    );
                    break;
                    }
                  case 'jadwal_tes':
    if (!loggedInUsers.has(from)) {
      await client.sendText(from, '⚠️ Silakan login terlebih dahulu.');
      return;
    }
  
    const userJadwal = loggedInUsers.get(from); // ✅ GANTI NAMA
    let jadwal = '';
  
    if (userJadwal.jenjang.toLowerCase().includes('sd')) {
      jadwal = '📅 Tes SD: 15 November 2025';
    } else if (userJadwal.jenjang.toLowerCase().includes('smp')) {
      jadwal = '📅 Tes SMP: 16 November 2025';
    } else if (userJadwal.jenjang.toLowerCase().includes('sma')) {
      jadwal = '📅 Tes SMA: 17 November 2025';
    } else {
      jadwal = '📅 Jadwal tes akan diinformasikan panitia.';
    }
  
    await client.sendText(
      from,
      `📝 *Jadwal Tes Masuk*\n
  👤 Nama: ${userJadwal.nama}
  📚 Jenjang: ${userJadwal.jenjang}
  
  ${jadwal}`
    );
    break;  
    case 'cetak': {
      if (!loggedInUsers.has(from)) {
        await client.sendText(from, '⚠️ Silakan login terlebih dahulu.');
        return;
      }
      const user = loggedInUsers.get(from);
      const noPendaftaran = user.username;
    
      // 1️⃣ CEK DI DATABASE APAKAH SUDAH ISI LANJUTAN
      const { data: lanjutan, error } = await supabase
        .from('pendaftaran_lanjutan')
        .select('*')
        .eq('no_pendaftaran', noPendaftaran)
        .maybeSingle();
    
      if (error) {
        console.error('❌ ERROR CEK LANJUTAN:', error.message);
        await client.sendText(from, '❌ Terjadi kesalahan sistem.');
        return;
      }
    
      if (!lanjutan) {
        await client.sendText(
          from,
    `⚠️ *Pendaftaran Lanjutan Belum Diisi*
    
    Silakan lengkapi *Pendaftaran Lanjutan* terlebih dahulu
    sebelum mencetak bukti pendaftaran.`
        );
        return;
      }

      const pdfPath = path.join(
        PDF_FOLDER,
        `${noPendaftaran}_lanjutan.pdf`
      );
    
      if (!fs.existsSync(pdfPath)) {
        // ambil data utama
        const { data: utama } = await supabase
          .from('pendaftaran')
          .select('*')
          .eq('no_pendaftaran', noPendaftaran)
          .single();
    
        if (!utama) {
          await client.sendText(from, '❌ Data pendaftaran utama tidak ditemukan.');
          return;
        }
    
        // generate ulang PDF
const doc = new PDFDocument({ margin: 50 });
const stream = fs.createWriteStream(pdfPath);

doc.pipe(stream);

// ===== JUDUL =====
doc
  .fontSize(16)
  .font('Helvetica-Bold')
  .text('FORMULIR PENDAFTARAN LANJUTAN', { align: 'center' });

doc.moveDown(1.5);

// helper sejajar
const labelX = 50;
const valueX = 200;
const lineGap = 18;

function row(label, value) {
  doc.font('Helvetica-Bold')
     .text(label, labelX, doc.y, { width: 140 });

  doc.font('Helvetica')
     .text(`: ${value || '-'}`, valueX, doc.y - lineGap, { width: 320 });

  doc.moveDown();
}

// ===== A. DATA PESERTA =====
doc.fontSize(12).font('Helvetica-Bold').text('A. DATA PESERTA');
doc.moveDown(0.5);
doc.font('Helvetica');

row('Nomor Pendaftaran', noPendaftaran);
row('Nama Murid', utama.nama);
row('Jenjang', utama.jenjang);

doc.moveDown();

// ===== B. DATA AYAH =====
doc.font('Helvetica-Bold').text('B. DATA AYAH');
doc.moveDown(0.5);
doc.font('Helvetica');

row('Nama Ayah', lanjutan.nama_ayah);
row('Pekerjaan Ayah', lanjutan.pekerjaan_ayah);
row('Pendidikan Ayah', lanjutan.pendidikan_ayah);
row('No HP Ayah', lanjutan.no_hp_ayah);

doc.moveDown();

// ===== C. DATA IBU =====
doc.font('Helvetica-Bold').text('C. DATA IBU');
doc.moveDown(0.5);
doc.font('Helvetica');

row('Nama Ibu', lanjutan.nama_ibu);
row('Pekerjaan Ibu', lanjutan.pekerjaan_ibu);
row('Pendidikan Ibu', lanjutan.pendidikan_ibu);
row('No HP Ibu', lanjutan.no_hp_ibu);

doc.moveDown();

// ===== D. DATA ALAMAT =====
doc.font('Helvetica-Bold').text('D. DATA ALAMAT');
doc.moveDown(0.5);
doc.font('Helvetica');

row('Alamat Lengkap', lanjutan.alamat);
row('Kelurahan', lanjutan.kelurahan);
row('Kecamatan', lanjutan.kecamatan);
row('Kota', lanjutan.kota);
row('Provinsi', lanjutan.provinsi);
row('Kode Pos', lanjutan.kode_pos);

doc.moveDown();

// ===== E. DATA TAMBAHAN =====
doc.font('Helvetica-Bold').text('E. DATA TAMBAHAN');
doc.moveDown(0.5);
doc.font('Helvetica');

row('Anak Ke', lanjutan.anak_ke);
row('Jumlah Saudara', lanjutan.jumlah_saudara);
row('Penghasilan Orang Tua', lanjutan.penghasilan_orangtua);
row(
  'Kebutuhan Khusus',
  lanjutan.kebutuhan_khusus ? 'Ya' : 'Tidak'
);
row('Keterangan Khusus', lanjutan.keterangan_khusus || '-');

// ===== FOOTER =====
doc.moveDown(2);
doc.fontSize(10).text(
  'Dokumen ini dicetak ulang melalui Sistem Pendaftaran SPMB.',
  { align: 'center' }
);

doc.end();

await new Promise(r => stream.on('finish', r));

      }
    
      // 3️⃣ KIRIM PDF
      await client.sendFile(
        from,
        pdfPath,
        `${noPendaftaran}_lanjutan.pdf`,
        `📄 *Bukti Pendaftaran Lanjutan*
    
    Nomor Pendaftaran: *${noPendaftaran}*`
      );
    
      break;
    }
    

  const user = loggedInUsers.get(from);
  const noPendaftaran = user.username;

  const pdfPath = path.join(
    PDF_FOLDER,
    `${noPendaftaran}_lanjutan.pdf`
  );

  // cek apakah file ada
  if (!fs.existsSync(pdfPath)) {
    await client.sendText(
      from,
      '❌ PDF pendaftaran lanjutan belum tersedia.\n\nSilakan lengkapi pendaftaran lanjutan terlebih dahulu.'
    );
    return;
  }

  await client.sendFile(
    from,
    pdfPath,
    `${noPendaftaran}_lanjutan.pdf`,
    `📄 *Bukti Pendaftaran Lanjutan*\n\nNomor Pendaftaran: *${noPendaftaran}*`
  );
  break;
          case 'logout':
            loggedInUsers.delete(from);
            await client.sendText(from, '✅ Anda berhasil logout.');
            await kirimMenu(client, from);
            break;      
                case 'back':
                  await kirimMenu(client, from);
                  break;
                default:
                  await client.sendText(from, '❌ Menu tidak dikenali. Ketik *SPMB* untuk membuka menu.');
              }
              return;
            }
            // Pesan pertama user
      if (!message.isGroupMsg && message.body && message.body.trim() !== '') {
        if (!sessions.has(from) && !selected) {
          await client.sendText(
            from,
      `🌟 *Selamat Datang di Sekolah Islam Al Azhar BSD* 🌟
      
      Kami siap membantu Anda memperoleh informasi seputar:
      🏫 Sekolah Islam Al Azhar BSD  
      🎓 Sistem Penerimaan Murid Baru (SPMB)
      
      Silakan pilih menu di bawah ini 👇`
          );
      
          await kirimMenuUtama(client, from);
          return;
        }
      }
    } catch (err) {
      console.error('❌ Error di onMessage:', err);
    }
  });
}

async function kirimFormDariTemplate(client, from) {
  const { data, error } = await supabase
    .from('info_spmb')
    .select('title, content')
    .eq('key', 'daftar')
    .eq('is_active', true)
    .maybeSingle();

  if (error || !data) {
    await client.sendText(from, '⚠️ Form pendaftaran belum tersedia.');
    return;
  }

  // SET SESSION SAMA SEPERTI SEKARANG
  sessions.set(waUser, { mode: 'combined' });

  await client.sendText(
    from,
    `📝 *${data.title}*\n\n${data.content}`
  );
}

      
// =============================
// Menu Login
// =============================
async function kirimMenuLogin(client, to) {
  const menus = await getMenuConfig('login');

  if (!menus || menus.length === 0) {
    await client.sendText(
      to,
      '⚠️ Menu login belum tersedia. Silakan hubungi panitia.'
    );
    return;
  }

  await client.sendListMessage(to, {
    title: '🔐 Menu Login SPMB',
    description: 'Silakan pilih layanan setelah login',
    buttonText: 'Menu Login',
    sections: [{
      title: '🔓 Layanan',
      rows: menus.map(m => ({
        rowId: m.menu_key,
        title: m.title,
        description: m.description || ''
      }))
    }]
  });
}


async function getTotalByJenjang(jenjang) {
  const { count, error } = await supabase
    .from('pendaftaran')
    .select('*', { count: 'exact', head: true })
    .eq('jenjang', jenjang);

  if (error) return 0;
  return count;
}

async function simpanPendaftaran(data) {
  const { error } = await supabase
    .from('pendaftaran')
    .insert(data);

  if (error) throw error;
}

// =============================
// 📄 Formulir Pendaftaran Gabungan
// =============================
async function kirimFormGabungan(client, from) {
  const text = `📝 *Formulir Pendaftaran SPMB Sekolah 2025*\n
Silakan isi data di bawah ini dalam *satu pesan*, seperti contoh:

1. Jenis Pendaftaran: Peserta Didik Baru
2. Jenjang Pendidikan: Playgroup
3. Nama Murid: Budi Santoso
4. Jenis Kelamin: Laki-laki
5. Tempat Lahir: Bandung
6. Tanggal Lahir: 2019-04-17
7. No. Telp: 0221234567
8. No. HP1: 08123456789
9. No. HP2: 08129876543
10. Email: budi@example.com

Kirim semua data di atas (copy) dalam satu pesan.
Ketik *batal* untuk membatalkan.

Note: Jenjang Pendidkan ada Toddler, Playgroup, Kelompok A, Kelompok B, SD, SMP, SMA`;

  sessions.set(waUser, { mode: 'combined' });
  await client.sendText(from, text);
}

// =============================
// 📥 Handle Form + Generate & Kirim PDF
// =============================
async function handleCombinedForm(client, message, from) {
  const text = (message.body || '').trim();

  // batal
  if (text.toLowerCase() === 'batal') {
    sessions.delete(from);
    await client.sendText(
      from,
      '✖️ Pendaftaran dibatalkan. Ketik *SPMB* untuk kembali ke menu.'
    );
    return;
  }

  try {
    const data = parseCombinedForm(text);
    const missingFields = getMissingRequiredFields(data);

if (missingFields.length > 0) {
  await client.sendText(
    from,
`⚠️ *Data Belum Lengkap*

Field berikut wajib diisi:
• ${missingFields.join('\n• ')}

✍️ Silakan *isi ulang formulir* dalam *SATU PESAN*
atau ketik *batal* untuk membatalkan pendaftaran.`
  );
  return;
}


// =============================
// 📧 VALIDASI EMAIL (HARUS GMAIL)
// =============================
if (!isValidGmail(data.email)) {
  await client.sendText(
    from,
`⚠️ *Email Tidak Valid*

Email yang digunakan *HARUS Gmail* (contoh: nama@gmail.com).

✍️ Silakan *ulangi pengisian formulir* dalam satu pesan
atau ketik *batal* untuk membatalkan pendaftaran.`
  );
  return;
}

if (data.no_telp && !isNumericPhone(data.no_telp)) {
  await client.sendText(
    from,
`⚠️ *No. Telp Tidak Valid*

No. Telp harus berupa *angka saja*.
Contoh: 021123456`
  );
  return;
}
// No HP1 (WAJIB & angka)
if (!data.no_hp1 || !isNumericPhone(data.no_hp1)) {
  await client.sendText(
    from,
`⚠️ *No. HP Utama Tidak Valid*

No. HP1 *WAJIB diisi* dan harus berupa *angka*.
Contoh: 08123456789`
  );
  return;
}
if (data.no_hp2 && !isNumericPhone(data.no_hp2)) {
  await client.sendText(
    from,
`⚠️ *No. HP Cadangan Tidak Valid*

No. HP2 harus berupa *angka saja* jika diisi.
Jika tidak ada, boleh dikosongkan.`
  );
  return;
}

    const sudahAda = await cekSudahDaftar(from, data.nama); 
    
    if (sudahAda) {
      await client.sendText(
        from,
        `❌ *Pendaftaran Ditolak*
    
    Nama *${data.nama}* sudah pernah terdaftar menggunakan nomor WhatsApp ini.
    
    Jika ingin mendaftarkan *anak lain*, silakan gunakan *nama yang berbeda*.`
      );
    
      sessions.delete(from);
      await client.sendText(
        from,
        `📌 Informasi ...
      
      ✍️ Ketik *kembali* untuk kembali ke menu.`
      );
      
      return;
    }
    const kodeJenjang = getKodeJenjang(data.jenjang || '');
    const kelompok = getKelompokJenjang(kodeJenjang);

    if (!kelompok) {
      await client.sendText(from, '⚠️ Jenjang tidak dikenali.');
      return;
    }

    const kuotaDashboard = await getKuotaDashboard();
    const totalSekarang = await getTotalByJenjang(data.jenjang);
    const keyJenjang = data.jenjang.toLowerCase().trim();
    const batas = parseInt(kuotaDashboard[keyJenjang] || 0);


    let statusKuota = 'normal';

if (batas > 0 && totalSekarang >= batas) {
  statusKuota = 'over';
}
if (statusKuota === 'over') {
  await client.sendText(
    from,
`⚠️ *Informasi Kuota*

Kuota target untuk jenjang *${data.jenjang}* telah tercapai.
Pendaftaran Anda *tetap diterima* dan akan diproses oleh panitia.`
  );
}


    const idPendaftaran = await generateNoPendaftaran(data.jenjang);

    //data.id = idPendaftaran;
    //data.whatsapp_from = from;

    // ===== SIMPAN PENDAFTARAN =====
    const { data: insertData, error: insertErr } = await supabase
  .from('pendaftaran')
  .insert({
    no_pendaftaran: idPendaftaran,
    jenis_pendaftaran: data.jenis_pendaftaran,
    jenjang: data.jenjang,
    nama: data.nama,
    jenis_kelamin: data.jenis_kelamin,
    tempat_lahir: data.tempat_lahir,
    tanggal_lahir: data.tanggal_lahir,
    no_telp: data.no_telp,
    no_hp1: data.no_hp1,
    no_hp2: data.no_hp2 || null,
    email: data.email,
    whatsapp: normalizePhone(data.no_hp1),
    wa_target: waUser
  })
  .select()
  .single();

if (insertErr) {
  console.error('❌ GAGAL INSERT PENDAFTARAN:', insertErr);
  await client.sendText(from, '❌ Pendaftaran gagal disimpan.');
  return;
}

console.log('✅ PENDAFTARAN TERSIMPAN:', insertData);

    
    // ===== MIDTRANS SNAP =====
    const orderIdMidtrans = generateOrderId(idPendaftaran);
    const biaya = getBiayaByJenjang(data.jenjang);

// 1️⃣ SIMPAN PEMBAYARAN DULU
const { error: bayarErr } = await supabase
  .from('pembayaran')
  .insert({
    order_id: orderIdMidtrans,
    no_pendaftaran: idPendaftaran,
    whatsapp: normalizePhone(data.no_hp1),
    wa_target: waUser,
    gross_amount: biaya,
    payment_type: 'snap',
    transaction_status: 'pending'
  });


if (bayarErr) {
  console.error('❌ GAGAL INSERT PEMBAYARAN:', bayarErr);
  await client.sendText(
    from,
    '❌ Terjadi kesalahan saat membuat transaksi pembayaran. Silakan coba lagi.'
  );
  return;
}

// 2️⃣ BARU CREATE SNAP
const snap = await createSnapTransaction({
  orderId: orderIdMidtrans,
  amount: biaya,
  customer: {
    nama: data.nama,
    phone: data.no_hp1,
    email: data.email
  }
});

// 3️⃣ UPDATE TOKEN & URL
await supabase
  .from('pembayaran')
  .update({
    snap_token: snap.token,
    redirect_url: snap.redirect_url
  })
  .eq('order_id', orderIdMidtrans);


    // ===== KIRIM LINK =====
    await client.sendText(
      from,
      `💳 *Pembayaran Pendaftaran SPMB*
    
    💰 Biaya: *Rp${biaya.toLocaleString('id-ID')}*
    
    Silakan klik link berikut untuk melakukan pembayaran:
    ${snap.redirect_url}

    Ketik *batal* jika ingin membatalkan pendaftaran.
    Waktu anda hanya 30 menit untuk menyelesaikan pembayarab
    
    (Setelah pembayaran, sistem akan memproses secara otomatis)`
    );    

    paymentSessions.set(waUser, {
      orderId: orderIdMidtrans,
      no_pendaftaran: idPendaftaran
    });

    // =============================
// ⏳ AUTO BATAL 30 MENIT
// =============================
const timeoutId = setTimeout(async () => {
  // cek apakah masih pending
  if (!paymentSessions.has(from)) return;

  const { orderId, no_pendaftaran } = paymentSessions.get(from);

  console.log('⏳ AUTO BATAL PEMBAYARAN:', orderId);

  // hapus pembayaran
  await supabase
    .from('pembayaran')
    .delete()
    .eq('order_id', orderId);

  // hapus pendaftaran
  await supabase
    .from('pendaftaran')
    .delete()
    .eq('no_pendaftaran', no_pendaftaran);

  paymentSessions.delete(from);
  paymentTimeouts.delete(from);

  if (globalClient) {
    await globalClient.sendText(
      from,
`⏳ *Waktu Pembayaran Habis*

Pendaftaran *dibatalkan otomatis*
karena pembayaran tidak diselesaikan
dalam *30 menit*.

✍️ Ketik *SPMB* untuk mendaftar kembali.`
    );
  }
}, 30 * 60 * 1000); // 30 menit

paymentTimeouts.set(from, timeoutId);


    sessions.delete(from);
  } catch (err) {
    console.error('❌ ERROR handleCombinedForm:', err);
    await client.sendText(from, '❌ Terjadi kesalahan. Silakan coba kembali.');
  }
}

// =============================
// 🔧 Fungsi Bantu
// =============================
function normalizeLanjutanData(data) {
  const {
    raw_input, // ❌ buang
    ...rest
  } = data;

  return {
    ...rest,
    anak_ke: rest.anak_ke ? parseInt(rest.anak_ke) : null,
    jumlah_saudara: rest.jumlah_saudara
      ? parseInt(rest.jumlah_saudara)
      : null,
    kebutuhan_khusus:
      typeof rest.kebutuhan_khusus === 'string'
        ? rest.kebutuhan_khusus.toLowerCase().includes('ya')
        : false
  };
}

function normalizePhone(number) {
  let n = number.replace(/\D/g, '');
  if (n.startsWith('0')) n = '62' + n.slice(1);
  if (!n.startsWith('62')) n = '62' + n;
  return n;
}


function getMissingRequiredFields(data) {
  const requiredFields = {
    jenis_pendaftaran: 'Jenis Pendaftaran',
    jenjang: 'Jenjang Pendidikan',
    nama: 'Nama Murid',
    jenis_kelamin: 'Jenis Kelamin',
    tempat_lahir: 'Tempat Lahir',
    tanggal_lahir: 'Tanggal Lahir',
    no_hp1: 'No HP Utama',
    email: 'Email'
  };

  const missing = [];

  for (const key in requiredFields) {
    if (!data[key] || data[key].trim() === '') {
      missing.push(requiredFields[key]);
    }
  }

  return missing;
}

function getUserWA(message) {
  // from = 628xxx@c.us
  return message.from.replace('@c.us', '');
}

function isValidGmail(email) {
  if (!email) return false;
  return email.toLowerCase().endsWith('@gmail.com');
}

function generateOrderId(noPendaftaran) {
  return `SPMB-${noPendaftaran}-${Date.now()}`;
}

function isNumericPhone(value) {
  if (!value) return false;
  return /^[0-9]+$/.test(value.trim());
}


function getMissingLanjutanFields(data) {
  const requiredFields = {
    nama_ayah: 'Nama Ayah',
    pekerjaan_ayah: 'Pekerjaan Ayah',
    pendidikan_ayah: 'Pendidikan Ayah',
    no_hp_ayah: 'No HP Ayah',
    nama_ibu: 'Nama Ibu',
    pekerjaan_ibu: 'Pekerjaan Ibu',
    pendidikan_ibu: 'Pendidikan Ibu',
    no_hp_ibu: 'No HP Ibu',
    alamat: 'Alamat Lengkap',
    kelurahan: 'Kelurahan',
    kecamatan: 'Kecamatan',
    kota: 'Kota',
    provinsi: 'Provinsi',
    kode_pos: 'Kode Pos',
    anak_ke: 'Anak Ke',
    jumlah_saudara: 'Jumlah Saudara',
    penghasilan_orangtua: 'Penghasilan Orang Tua',
    kebutuhan_khusus: 'Kebutuhan Khusus',
    //keterangan_khusus: 'Keterangan Khusus'
  };

  const missing = [];

  for (const key in requiredFields) {
    if (!data[key] || data[key].toString().trim() === '') {
      missing.push(requiredFields[key]);
    }
  }

  return missing;
}

function parseFormLanjutan(text) {
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);

  const data = {
    nama_ayah: '',
    pekerjaan_ayah: '',
    pendidikan_ayah: '',
    no_hp_ayah: '',
    nama_ibu: '',
    pekerjaan_ibu: '',
    pendidikan_ibu: '',
    no_hp_ibu: '',
    alamat: '',
    kelurahan: '',
    kecamatan: '',
    kota: '',
    provinsi: '',
    kode_pos: '',
    anak_ke: '',
    jumlah_saudara: '',
    penghasilan_orangtua: '',
    kebutuhan_khusus: '',
    keterangan_khusus: '',
    raw_input: text
  };

  for (const line of lines) {
    const lower = line.toLowerCase();
    const val = ambilNilai(line);

    if (lower.includes('nama ayah')) data.nama_ayah ||= val;
    else if (lower.includes('pekerjaan ayah')) data.pekerjaan_ayah ||= val;
    else if (lower.includes('pendidikan ayah')) data.pendidikan_ayah ||= val;
    else if (lower.includes('hp ayah') || lower.includes('no hp ayah')) data.no_hp_ayah ||= val;

    else if (lower.includes('nama ibu')) data.nama_ibu ||= val;
    else if (lower.includes('pekerjaan ibu')) data.pekerjaan_ibu ||= val;
    else if (lower.includes('pendidikan ibu')) data.pendidikan_ibu ||= val;
    else if (lower.includes('hp ibu') || lower.includes('no hp ibu')) data.no_hp_ibu ||= val;

    else if (lower.includes('alamat')) data.alamat ||= val;
    else if (lower.includes('kelurahan')) data.kelurahan ||= val;
    else if (lower.includes('kecamatan')) data.kecamatan ||= val;
    else if (lower.includes('kota')) data.kota ||= val;
    else if (lower.includes('provinsi')) data.provinsi ||= val;
    else if (lower.includes('kode pos')) data.kode_pos ||= val;

    else if (lower.includes('anak ke')) data.anak_ke ||= val;
    else if (lower.includes('jumlah saudara')) data.jumlah_saudara ||= val;
    else if (lower.includes('penghasilan')) data.penghasilan_orangtua ||= val;
    else if (lower.includes('kebutuhan khusus')) data.kebutuhan_khusus ||= val;
    else if (lower.includes('keterangan')) data.keterangan_khusus ||= val;
  }

  return data;
}

function parseCombinedForm(text) {
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  const data = {
    jenis_pendaftaran: '',
    jenjang: '',
    nama: '',
    jenis_kelamin: '',
    tempat_lahir: '',
    tanggal_lahir: '',
    no_telp: '',
    no_hp1: '',
    no_hp2: '',
    email: '',
    raw_input: text
  };

  for (const line of lines) {
    const lower = line.toLowerCase();
    const val = ambilNilai(line);

    if (lower.includes('pendaftaran')) data.jenis_pendaftaran ||= val;
    else if (lower.includes('jenjang')) data.jenjang ||= val;
    else if (lower.includes('nama') || lower.includes('murid')) data.nama ||= val;
    else if (lower.includes('kelamin')) data.jenis_kelamin ||= val;
    else if (lower.includes('tempat')) data.tempat_lahir ||= val;
    else if (lower.includes('tanggal')) data.tanggal_lahir ||= val;
    else if (lower.includes('telp')) data.no_telp ||= val;
    else if (lower.includes('hp1')) data.no_hp1 ||= val;
    else if (lower.includes('hp2')) data.no_hp2 ||= val;
    else if (lower.includes('email')) data.email ||= val;
  }
  return data;
}

function ambilNilai(line) {
  const parts = line.split(':');
  if (parts.length > 1) return parts.slice(1).join(':').trim();
  return line.replace(/^\d+\.\s*/, '').trim();
}

function getBiayaByJenjang(jenjang) {
  const j = jenjang.toLowerCase();

  // Toddler & TK
  if (
    j.includes('toddler') ||
    j.includes('playgroup') ||
    j.includes('kelompok a') ||
    j.includes('kelompok b')
  ) {
    return 300000;
  }

  // SD & SMP
  if (j.includes('sd') || j.includes('smp')) {
    return 350000;
  }

  // SMA
  if (j.includes('sma')) {
    return 400000;
  }

  // default (jaga-jaga)
  return 300000;
}

function getKodeJenjang(jenjang) {
  const j = jenjang.toLowerCase();
  if (j.includes('toddler')) return '13';
  if (j.includes('playgroup')) return '14';
  if (j.includes('kelompok a')) return '15';
  if (j.includes('kelompok b')) return '16';
  if (j.includes('sd')) return '01';
  if (j.includes('smp')) return '07';
  if (j.includes('sma')) return '10';
  return '00';
}

function getPrefixByJenjang(jenjang) {
  const j = jenjang.toLowerCase();

  if (j.includes('sd')) return '262701';
  if (j.includes('smp')) return '262707';
  if (j.includes('sma')) return '262710';
  if (j.includes('toddler')) return '262717';
  if (j.includes('kelompok a') || j.includes('tk a')) return '262716';
  if (j.includes('kelompok b') || j.includes('tk b')) return '262715';
  if (j.includes('playgroup')) return '262713';

  throw new Error('Jenjang tidak valid');
}


async function cekSudahDaftar(waUser, nama) {
  const { data, error } = await supabase
    .from('pendaftaran')
    .select('id')
    .eq('whatsapp', waUser)
    .ilike('nama', nama) // case-insensitive
    .limit(1);

  if (error) {
    console.error('❌ ERROR cek pendaftaran:', error.message);
    return false;
  }

  return data && data.length > 0;
}

const waUser = getUserWA(message);
const sudahAda = await cekSudahDaftar(waUser, data.nama);

// =============================
// 📋 Menu WhatsApp
// =============================
async function kirimMenuUtama(client, to) {
  await client.sendListMessage(to, {
    title: '🏫 Al Azhar BSD',
    description: 'Silakan pilih layanan yang Anda butuhkan',
    buttonText: 'Menu Utama',
    sections: [
      {
        title: '📌 Menu',
        rows: [
          {
            rowId: 'info_umum',
            title: 'Informasi Umum',
            description: 'Profil, lowongan kerja, kontak, dll'
          },
          {
            rowId: 'spmb',
            title: 'SPMB',
            description: 'Pendaftaran & informasi SPMB'
          }
        ]
      }
    ]
  });
}

// =============================
// 🕒 Auto Reset Human Mode
// =============================
setInterval(() => {
  if (!globalClient) return; // pastikan client sudah ada

  const now = Date.now();
  const timeout = 5 * 60 * 1000;

  for (const [num, lastTime] of lastReplyTime.entries()) {
    if (humanMode.has(num) && now - lastTime >= timeout) {
      humanMode.delete(num);
      lastReplyTime.delete(num);

      globalClient.sendText(
        num,
        '⏳ *Sesi chat dengan panitia telah berakhir karena tidak ada balasan selama 5 menit.*\n\nKetik *SPMB* untuk kembali ke menu utama.'
      ).catch(console.error);
    }
  }
}, 60 * 1000);
