const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const axios = require('axios');

// Panggil MySQL Database (akan otomatis bikin Table Schema saat pertama dirun)
const db = require('./db');

const app = express();
app.use(cors({ origin: '*' })); 
app.use(express.json({ limit: '50mb' }));

const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: '*',
        methods: ['GET', 'POST']
    }
});

const sessions = new Map();

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const initializeSession = (sessionId) => {
    if (sessions.has(sessionId)) return sessions.get(sessionId);

    const safeClientId = sessionId.replace(/[^a-zA-Z0-9_-]/g, '_');

    const client = new Client({
        authStrategy: new LocalAuth({ clientId: safeClientId }), 
        puppeteer: {
            headless: true,
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

    const sessionData = { 
        id: sessionId, 
        client: client, 
        status: 'Initializing', 
        qr: null 
    };
    sessions.set(sessionId, sessionData);
    
    // Sinkronisasi status ke DB
    db.saveSession(sessionId, 'Initializing');

    client.on('qr', (qr) => {
        console.log(`[${sessionId}] QR Generated.`);
        sessionData.qr = qr;
        sessionData.status = 'Scan QR';
        db.saveSession(sessionId, 'Scan QR');
        io.emit('wa_qr', { sessionId, qr });
        io.emit('wa_status', { sessionId, status: 'Scan QR' });
    });

    client.on('authenticated', () => {
        console.log(`[${sessionId}] Authenticated!`);
        sessionData.qr = null;
        sessionData.status = 'Authenticated';
        db.saveSession(sessionId, 'Authenticated');
        io.emit('wa_status', { sessionId, status: 'Authenticated' });
    });

    client.on('auth_failure', (msg) => {
        console.error(`[${sessionId}] Auth Failed:`, msg);
        sessionData.status = 'Auth Failure';
        db.saveSession(sessionId, 'Auth Failure');
        io.emit('wa_status', { sessionId, status: 'Auth Failure' });
    });

    client.on('ready', () => {
        console.log(`[${sessionId}] Ready!`);
        sessionData.status = 'Ready';
        db.saveSession(sessionId, 'Ready');
        io.emit('wa_status', { sessionId, status: 'Ready' });
    });

    client.on('disconnected', (reason) => {
        console.log(`[${sessionId}] Disconnected:`, reason);
        sessionData.status = 'Disconnected';
        db.saveSession(sessionId, 'Disconnected');
        io.emit('wa_status', { sessionId, status: 'Disconnected' });
        
        client.destroy();
        sessions.delete(sessionId);
        setTimeout(() => initializeSession(sessionId), 5000);
    });

    client.on('message', async (msg) => {
        if (msg.from === 'status@broadcast') return;

        let senderName = msg.from;
        try {
            const contact = await msg.getContact();
            senderName = contact.pushname || contact.name || contact.number || msg.from;
        } catch (e) { }

        const payload = {
            id: msg.id._serialized,
            sessionId: sessionId,
            body: msg.body,
            from: msg.from,
            senderName: senderName,
            timestamp: new Date().toLocaleTimeString('id-ID'),
        };

        // Simpan Permanen ke MySQL Database
        db.saveInbox(payload);

        io.emit('wa_message', payload);

        // --- SISTEM BOT AUTO-RESPONDER ---
        try {
            const rules = await db.getAutoReplies();
            const incomingText = msg.body.trim().toLowerCase();
            
            for (const rule of rules) {
                const keywordText = rule.keyword.trim().toLowerCase();
                let isMatch = false;

                if (rule.is_exact_match) {
                    isMatch = (incomingText === keywordText);
                } else {
                    isMatch = incomingText.includes(keywordText);
                }

                if (isMatch) {
                    await client.sendMessage(msg.from, rule.response_message);
                    
                    const replyPayload = {
                        sessionId: sessionId,
                        body: rule.response_message,
                        from: msg.from,
                        senderName: 'Bot CS',
                        timestamp: new Date().toLocaleTimeString('id-ID'),
                        isOutgoing: true
                    };
                    db.saveInbox(replyPayload);
                    io.emit('chat_reply', replyPayload);
                    break; // Jangan balas ganda jika 2 aturan cocok
                }
            }
        } catch (botErr) { console.error("Auto Responder Error:", botErr); }
    });

    client.initialize().catch(err => {
        console.error(`[${sessionId}] Init Error:`, err);
        db.saveSession(sessionId, 'Init Error');
    });

    return sessionData;
};

// Tunggu MySQL XAMPP terkoneksi terlebih dulu
setTimeout(async () => {
    let savedSessions = await db.getAllSessions();
    if (savedSessions.length === 0) {
        savedSessions = ['Akun WA Utama'];
    }
    savedSessions.forEach(id => initializeSession(id));
}, 2000);


io.on('connection', async (socket) => {
    console.log('Frontend terhubung ID:', socket.id);
    const states = [];
    sessions.forEach((data, id) => {
        states.push({ sessionId: id, status: data.status, qr: data.qr });
    });
    socket.emit('init_sessions', states);

    // Ambil Data Inbox & Logs dari MySQL dan tembak saat Connect Pertama!
    const dbInbox = await db.getRecentInboxDesc();
    if (dbInbox && dbInbox.length > 0) {
        // Balik array biar urutan di UI tidak terbalik dari atas ke bawah (React butuh push ke array atau mapping sebaliknya)
        // Tergantung UI-nya sih, kalau di prepend kita tembak 1-1, kalau state update utuh kita kirim `init_inbox`
        socket.emit('init_inbox', dbInbox);
    }
});

app.post('/api/sessions/create', async (req, res) => {
    const { sessionId } = req.body;
    if (!sessionId || sessions.has(sessionId)) {
        return res.status(400).json({ error: 'Nama Session Kosong Atau Sudah Dipakai.' });
    }
    
    // Save to DB
    await db.saveSession(sessionId, 'Initializing');

    initializeSession(sessionId);
    io.emit('session_created', { sessionId, status: 'Initializing' });
    res.json({ message: `Sesi ${sessionId} diciptakan.` });
});

app.post('/api/sessions/delete', async (req, res) => {
    const { sessionId } = req.body;
    if (!sessionId || !sessions.has(sessionId)) return res.status(400).json({error: 'Invalid ID'});

    const sessionData = sessions.get(sessionId);
    if (sessionData.client) await sessionData.client.destroy().catch(()=>{});
    sessions.delete(sessionId);
    
    await db.deleteSession(sessionId);

    io.emit('session_deleted', { sessionId });
    res.json({ message: `Session ${sessionId} di-Drop dari Database.` });
});

app.post('/api/blast', async (req, res) => {
    const { sessionId, numbers, message, media } = req.body;

    if (!sessionId || !sessions.has(sessionId)) {
        return res.status(400).json({ error: 'Sesi WA tidak valid.' });
    }

    const sessionData = sessions.get(sessionId);
    if (sessionData.status !== 'Ready' && sessionData.status !== 'Authenticated') {
        return res.status(400).json({ error: `WhatsApp Sesi [${sessionId}] Belum Di-scan Di HP.` });
    }

    if (!Array.isArray(numbers) || numbers.length === 0) {
        return res.status(400).json({ error: 'Array numbers kosong.' });
    }
    
    let msgMedia = null;
    if (media && media.data && media.mimetype) {
        msgMedia = new MessageMedia(media.mimetype, media.data, media.filename || 'attachment');
    }

    res.json({ message: `Tembakan Blast dimulai` });
    io.emit('blast_start', { sessionId, total: numbers.length });

    for (let i = 0; i < numbers.length; i++) {
        let number = numbers[i].toString().trim().replace(/[-\s+]/g, '');
        const chatId = `${number}@c.us`;
        let statusKirim = '';

        try {
            const isRegistered = await sessionData.client.isRegisteredUser(chatId);
            if (isRegistered) {
                if (msgMedia) await sessionData.client.sendMessage(chatId, msgMedia, { caption: message || '' });
                else await sessionData.client.sendMessage(chatId, message || '');
                statusKirim = 'Berhasil Terkirim';
            } else {
                statusKirim = 'Gagal (No. Tak Terdaftar)';
            }
        } catch (error) {
            statusKirim = `Error: ${error.message}`;
        }

        // SIMPAN LOG TIAP NOMOR KE MYSQL DB XAMPP
        db.saveBlastLog(sessionId, number, statusKirim, message);

        io.emit('blast_progress', { 
            sessionId, index: i + 1, total: numbers.length, 
            status: statusKirim, number: number 
        });

        if (i < numbers.length - 1) {
            const waitTime = Math.floor(Math.random() * (12000 - 5000 + 1)) + 5000;
            io.emit('blast_wait', { sessionId, ms: waitTime });
            await delay(waitTime);
        }
    }

    io.emit('blast_finished', { sessionId, total: numbers.length });
});

app.post('/api/chat/history', async (req, res) => {
    const { sessionId, senderNumber } = req.body;
    if (!sessionId || !senderNumber) return res.status(400).json({ error: 'Data tidak lengkap' });
    const history = await db.getChatHistory(sessionId, senderNumber);
    res.json(history);
});

app.post('/api/chat/send', async (req, res) => {
    const { sessionId, targetNumber, message } = req.body;
    if (!sessionId || !targetNumber || !message) return res.status(400).json({ error: 'Data tidak lengkap' });
    
    const sessionData = sessions.get(sessionId);
    if (!sessionData || (sessionData.status !== 'Ready' && sessionData.status !== 'Authenticated')) {
        return res.status(400).json({ error: 'Sesi WhatsApp tidak valid/siap.' });
    }
    
    // Biasanya format msg.from itu '628xxx@c.us'
    const chatId = targetNumber.includes('@') ? targetNumber : `${targetNumber.replace(/[-\s+]/g, '')}@c.us`;
    
    try {
        await sessionData.client.sendMessage(chatId, message);
        const payload = {
            sessionId: sessionId,
            body: message,
            from: targetNumber, // Target as 'from' field so DB query matches
            senderName: 'Anda (CS)',
            timestamp: new Date().toLocaleTimeString('id-ID'),
            isOutgoing: true
        };
        db.saveInbox(payload);
        // Supaya UI seketika terupdate tanpa perlu reload db
        // io.emit('wa_message', payload); 
        // Mengubah strategy, kita kirim real-time lewat event chat_reply spesifik
        io.emit('chat_reply', payload);
        
        res.json({ success: true, payload });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// --- API TARIK GOOGLE SHEETS KHUSUS ---
app.post('/api/import-sheets', async (req, res) => {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: "Link Google Sheets tidak valid." });

    // Coba temukan ID Spreadsheet (Format: /d/XXXXXX/)
    const match = url.match(/\/d\/([a-zA-Z0-9-_]+)/);
    if (!match) return res.status(400).json({ error: "Gagal menemukan ID Dokumen. Pastikan Copy utuh Link Google Sheets." });
    
    const sheetId = match[1];
    const exportUrl = `https://docs.google.com/spreadsheets/d/${sheetId}/export?format=csv`;

    try {
        const response = await axios.get(exportUrl, { responseType: 'text' });
        const csvData = response.data;
        
        const allNumbers = [];
        // Pembersihan CSV: pisahkan baris dan koma, bersihkan karakter aneh
        const cells = csvData.split(/[\n,;\t]+/);
        
        for (const cell of cells) {
            const cleanStr = String(cell).replace(/[-\s+"']/g, ''); // bersihkan spasi, strip, tanda kutip
            if (cleanStr.match(/^(62|08)[0-9]{8,15}$/)) {
                allNumbers.push(cleanStr);
            }
        }
        
        const unique = [...new Set(allNumbers)];
        res.json({ success: true, count: unique.length, numbers: unique });
    } catch (e) {
        if (e.response && e.response.status === 401 || e.response?.status === 403) {
            return res.status(400).json({ error: "Google Sheets Digembok. Pastikan menu Share / Bagikan telah disetting ke 'Anyone with the link' (Siapa saja yang memiliki tautan)." });
        }
        res.status(500).json({ error: "Gagal menarik data dari Google. Link rusak atau file kosong." });
    }
});

app.get('/api/autoreply/list', async (req, res) => {
    res.json(await db.getAutoReplies());
});

app.post('/api/autoreply/add', async (req, res) => {
    const { keyword, response, isExact } = req.body;
    if(!keyword || !response) return res.status(400).json({error: 'Harap isi semua kolom'});
    const validExact = isExact !== undefined ? isExact : true;
    const ok = await db.saveAutoReply(keyword, response, validExact);
    if(ok) res.json({success: true});
    else res.status(500).json({error: 'Gagal meresim query Chatbot ke database.'});
});

app.post('/api/autoreply/delete', async (req, res) => {
    const { id } = req.body;
    await db.deleteAutoReply(id);
    res.json({success: true});
});

// --- API MANAJEMEN KONTAK / BUKU TELEPON ---
app.get('/api/contacts/:sessionId', async (req, res) => {
    const { sessionId } = req.params;
    if (!sessionId) return res.status(400).json({ error: 'Session ID diperlukan' });
    res.json(await db.getAllContacts(sessionId));
});

app.post('/api/contacts/save', async (req, res) => {
    const { sessionId, contacts } = req.body; 
    // contacts bisa berupa array objek [{name: "A", number: "123"}] untuk bulk insert, 
    // atau sekadar 1 objek jika manual insert.
    if (!sessionId || !contacts) return res.status(400).json({ error: 'Data tidak lengkap' });

    let successCount = 0;
    const contactList = Array.isArray(contacts) ? contacts : [contacts];

    for (let c of contactList) {
        if (c.number) {
            const cleanNumber = String(c.number).replace(/[-\s+]/g, '');
            const ok = await db.saveContact(sessionId, c.name || cleanNumber, cleanNumber);
            if (ok) successCount++;
        }
    }
    res.json({ success: true, message: `${successCount} kontak berhasil disimpan.` });
});

app.post('/api/contacts/delete', async (req, res) => {
    const { id } = req.body;
    if (!id) return res.status(400).json({ error: 'ID Kontak diperlukan' });
    await db.deleteContact(id);
    res.json({ success: true });
});


app.post('/api/logout', async (req, res) => {
    const { sessionId } = req.body;
    if (!sessionId || !sessions.has(sessionId)) return res.status(400).json({error: 'Invalid ID'});

    const sessionData = sessions.get(sessionId);
    try {
        if (sessionData.client) {
            await sessionData.client.logout();
            sessionData.status = 'Logged Out';
            db.saveSession(sessionId, 'Logged Out');
            io.emit('wa_status', { sessionId, status: 'Logged Out' });
            setTimeout(() => {
                sessionData.client.destroy();
                sessions.delete(sessionId);
                initializeSession(sessionId);
            }, 3000);
        }
        res.json({ message: 'Success Logout' });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`Node Server berjalan di Port ${PORT} (0.0.0.0 Terbuka)`);
});
