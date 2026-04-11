const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');

// Array daftar nomor telepon tujuan
// Pastikan nomor menggunakan kode negara (misal '62' untuk Indonesia, tanpa '+' atau '0' di depan)
const phoneNumbers = [
    '6281234567890',
    '6289876543210'
];

// Pesan yang akan dikirim (bisa disesuaikan)
const messageTemplate = "Halo! Ini adalah pesan simulasi broadcast server kami. Terima kasih.";

// Helper function untuk memberikan jeda (delay)
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Inisialisasi client WhatsApp dengan LocalAuth untuk menyimpan sesi
const client = new Client({
    authStrategy: new LocalAuth(
        // { clientId: "client-one" } // Opsional: Beri ID jika menjalankan banyak sesi
    ),
    puppeteer: {
        headless: true,
        // Argumen ini direkomendasikan agar Puppeteer berjalan lancar di berbagai sistem operasi
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--no-first-run',
            '--no-zygote',
            '--disable-gpu'
        ]
    }
});

// Event ketika QR Code harus di-scan
client.on('qr', (qr) => {
    // Generate QR code di terminal dengan ukuran kecil
    qrcode.generate(qr, { small: true });
    console.log('Silakan scan QR Code di atas menggunakan aplikasi WhatsApp di HP Anda.');
});

// Event ketika berhasil autentikasi
client.on('authenticated', () => {
    console.log('Autentikasi berhasil! Sesi akan disimpan (LocalAuth).');
});

// Event jika gagal autentikasi
client.on('auth_failure', msg => {
    console.error('Autentikasi gagal. Silakan coba lagi:', msg);
});

// Event saat client siap digunakan
client.on('ready', () => {
    console.log('Client WhatsApp telah siap!');
    // Memulai fungsi pengiriman pesan
    startBroadcast();
});

// Fungsi utama untuk loop pengiriman pesan
async function startBroadcast() {
    console.log(`\n=== Memulai proses broadcast ke ${phoneNumbers.length} nomor tujuan ===\n`);
    
    for (let i = 0; i < phoneNumbers.length; i++) {
        const number = phoneNumbers[i];
        
        // WhatsApp Web JS memerlukan format '@c.us' pada ID chat pengguna biasa
        const chatId = `${number}@c.us`;

        try {
            // Mengecek ketersediaan nomor di WhatsApp sebelum mengirim (opsional tapi disarankan)
            const isRegistered = await client.isRegisteredUser(chatId);
            
            if (isRegistered) {
                // Mengirim pesan teks
                await client.sendMessage(chatId, messageTemplate);
                console.log(`✅ [${i + 1}/${phoneNumbers.length}] Berhasil: Pesan terkirim ke ${number}`);
            } else {
                console.log(`❌ [${i + 1}/${phoneNumbers.length}] Gagal: Nomor ${number} tidak terdaftar di WhatsApp.`);
            }
        } catch (error) {
            console.error(`❌ [${i + 1}/${phoneNumbers.length}] Error saat mengirim ke ${number}:`, error.message);
        }

        // JEDA (DELAY) ASINKRONUS PENCEGAHAN SPAM
        // Sangat disarankan untuk tidak mengirim terlalu cepat (bisa ban/diblokir oleh sistem spam Meta)
        // Kita memberikan jeda acak di antara rentang waktu tertentu
        if (i < phoneNumbers.length - 1) { // Tidak perlu menunggu jika ini adalah nomor terakhir
            // Jeda acak antara 5 sampai 12 detik (misal)
            const waitTime = Math.floor(Math.random() * (12000 - 5000 + 1)) + 5000;
            console.log(`   ⏳ Menunggu jeda ${waitTime / 1000} detik sebelum pesan berikutnya...\n`);
            await delay(waitTime);
        }
    }
    
    console.log('\n=== Proses broadcast telah selesai! ===');
    
    // Opsional: Matikan client setelah pengiriman selesai (Uncomment baris di bawah ini)
    // console.log('Menutup client...');
    // await client.destroy();
    // process.exit(0);
}

// Menghidupkan client
client.initialize();
