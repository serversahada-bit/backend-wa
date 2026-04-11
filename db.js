const mysql = require('mysql2/promise');

// Konfigurasi Root XAMPP
const dbConfig = {
    host: 'localhost',
    user: 'root',
    password: '', // Default XAMPP tanpa password
    database: 'wa_blast_db'
};

let pool;

async function initDB() {
    try {
        const connection = await mysql.createConnection({
            host: dbConfig.host,
            user: dbConfig.user,
            password: dbConfig.password
        });
        
        await connection.query(`CREATE DATABASE IF NOT EXISTS \`${dbConfig.database}\`;`);
        await connection.end();

        pool = mysql.createPool({
            ...dbConfig,
            waitForConnections: true,
            connectionLimit: 10,
            enableKeepAlive: true,
            keepAliveInitialDelay: 0,
            queueLimit: 0
        });

        console.log('✅ XAMPP MySQL Terkoneksi & Database wa_blast_db Siap.');

        await pool.query(`
            CREATE TABLE IF NOT EXISTS wa_sessions (
                session_id VARCHAR(50) PRIMARY KEY,
                status VARCHAR(50) DEFAULT 'Initializing',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);

        await pool.query(`
            CREATE TABLE IF NOT EXISTS wa_inbox (
                id INT AUTO_INCREMENT PRIMARY KEY,
                session_id VARCHAR(50),
                sender_number VARCHAR(100),
                sender_name VARCHAR(100),
                message TEXT,
                timestamp VARCHAR(50),
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (session_id) REFERENCES wa_sessions(session_id) ON DELETE CASCADE
            );
        `);
        
        // Auto-Migrate Kolom untuk fitur Balas Pesan (1 on 1 Chat / CS Dashboard)
        try {
            await pool.query('ALTER TABLE wa_inbox ADD COLUMN is_outgoing BOOLEAN DEFAULT FALSE;');
            console.log('✅ Berhasil Menambahkan Kolom Chat Keluar (is_outgoing).');
        } catch (e) {
            // Abaikan jika kolom sudah ada.
        }

        await pool.query(`
            CREATE TABLE IF NOT EXISTS wa_blast_logs (
                id INT AUTO_INCREMENT PRIMARY KEY,
                session_id VARCHAR(50),
                target_number VARCHAR(50),
                status VARCHAR(100),
                message_sent TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (session_id) REFERENCES wa_sessions(session_id) ON DELETE CASCADE
            );
        `);

        // Fitur Bot Chatbot Auto Tracker
        await pool.query(`
            CREATE TABLE IF NOT EXISTS wa_autoreplies (
                id INT AUTO_INCREMENT PRIMARY KEY,
                keyword VARCHAR(255) UNIQUE,
                response_message TEXT,
                is_exact_match BOOLEAN DEFAULT TRUE,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);

        // Fitur Kontak / Buku Telepon per Sesi
        await pool.query(`
            CREATE TABLE IF NOT EXISTS wa_contacts (
                id INT AUTO_INCREMENT PRIMARY KEY,
                session_id VARCHAR(50),
                contact_name VARCHAR(100),
                contact_number VARCHAR(50),
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                UNIQUE KEY unique_contact (session_id, contact_number),
                FOREIGN KEY (session_id) REFERENCES wa_sessions(session_id) ON DELETE CASCADE
            );
        `);

        console.log('✅ Tabel MySQL wa_sessions, wa_inbox, wa_blast_logs, wa_autoreplies, wa_contacts berhasil divalidasi.');

    } catch (err) {
        console.error('❌ DATABASE ERROR: Pastikan Apache & MySQL di aplikasi XAMPP Anda sudah berstatus "Running" atau "Start".');
        console.error(err.message);
    }
}

initDB();

module.exports = {
    getPool: () => pool,
    
    saveSession: async (sessionId, status) => {
        if(!pool) return;
        try {
            await pool.query(
                'INSERT INTO wa_sessions (session_id, status) VALUES (?, ?) ON DUPLICATE KEY UPDATE status = ?',
                [sessionId, status, status]
            );
        } catch(e) {}
    },
    
    deleteSession: async (sessionId) => {
        if(!pool) return;
        try {
            await pool.query('DELETE FROM wa_sessions WHERE session_id = ?', [sessionId]);
        } catch(e) {}
    },

    getAllSessions: async () => {
        if(!pool) return [];
        try {
            const [rows] = await pool.query('SELECT session_id, status FROM wa_sessions');
            return rows.map(r => r.session_id);
        } catch(e) { return []; }
    },

    saveInbox: async (data) => {
        if(!pool) return;
        try {
            await pool.query(
                'INSERT INTO wa_inbox (session_id, sender_number, sender_name, message, timestamp, is_outgoing) VALUES (?, ?, ?, ?, ?, ?)',
                [data.sessionId, data.from, data.senderName, data.body, data.timestamp, data.isOutgoing || false]
            );
        } catch(e) { console.error("DB Inbox Error", e); }
    },

    saveBlastLog: async (sessionId, targetNumber, status, messageSent) => {
        if(!pool) return;
        try {
            await pool.query(
                'INSERT INTO wa_blast_logs (session_id, target_number, status, message_sent) VALUES (?, ?, ?, ?)',
                [sessionId, targetNumber, status, messageSent]
            );
        } catch(e) {}
    },

    getRecentInboxDesc: async () => {
        if(!pool) return [];
        try {
           // Mengambil List inbox teratas yang bukan outgoing (agar list di sebelah kiri mewakili pesan kliennya saja, atau ambil semua juga tidak masalah)
           // Kita ambil semua saja supaya tahu kita sudah membalas atau belum kalau kita mapping di React.
           const [rows] = await pool.query('SELECT * FROM wa_inbox ORDER BY created_at DESC LIMIT 150');
           return rows.map(r => ({
              sessionId: r.session_id,
              from: r.sender_number,
              senderName: r.sender_name,
              body: r.message,
              timestamp: r.timestamp,
              isOutgoing: r.is_outgoing == 1 ? true : false
           }));
        } catch(e) { return []; }
    },
    
    getChatHistory: async (sessionId, senderNumber) => {
        if(!pool) return [];
        try {
            const [rows] = await pool.query('SELECT * FROM wa_inbox WHERE session_id = ? AND sender_number = ? ORDER BY created_at ASC', [sessionId, senderNumber]);
            return rows.map(r => ({
              sessionId: r.session_id,
              from: r.sender_number,
              senderName: r.sender_name,
              body: r.message,
              timestamp: r.timestamp,
              isOutgoing: r.is_outgoing == 1 ? true : false
           }));
        } catch(e) {
            return [];
        }
    },

    getRecentBlastLogs: async () => {
        if(!pool) return [];
        try {
           const [rows] = await pool.query('SELECT * FROM wa_blast_logs ORDER BY created_at ASC LIMIT 200');
           return rows.map(r => ({
              sessionId: r.session_id,
              type: r.status.includes('Sukses') ? 'success' : r.status.includes('Error') ? 'error' : 'info',
              text: `[${r.session_id}] [DB] ${r.target_number} - ${r.status}`,
              status: r.status
           }));
        } catch(e) { return []; }
    },

    getAutoReplies: async () => {
        if(!pool) return [];
        try {
            const [rows] = await pool.query('SELECT * FROM wa_autoreplies ORDER BY created_at DESC');
            return rows;
        } catch(e) { return []; }
    },

    saveAutoReply: async (keyword, response, isExact) => {
        if(!pool) return false;
        try {
            await pool.query(
                'INSERT INTO wa_autoreplies (keyword, response_message, is_exact_match) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE response_message = ?, is_exact_match = ?',
                [keyword.trim().toLowerCase(), response, isExact, response, isExact]
            );
            return true;
        } catch(e) { return false; }
    },

    deleteAutoReply: async (id) => {
        if(!pool) return false;
        try {
            await pool.query('DELETE FROM wa_autoreplies WHERE id = ?', [id]);
            return true;
        } catch(e) { return false; }
    },

    getAllContacts: async (sessionId) => {
        if(!pool) return [];
        try {
            const [rows] = await pool.query('SELECT * FROM wa_contacts WHERE session_id = ? ORDER BY contact_name ASC', [sessionId]);
            return rows;
        } catch(e) { return []; }
    },

    saveContact: async (sessionId, name, number) => {
        if(!pool) return false;
        try {
            // Kita gunakan upsert (ON DUPLICATE KEY UPDATE) supaya tidak duplikat jika nomor sama untuk sesi yang sama
            await pool.query(
                `INSERT INTO wa_contacts (session_id, contact_name, contact_number) 
                 VALUES (?, ?, ?) 
                 ON DUPLICATE KEY UPDATE contact_name = ?`,
                [sessionId, name, number, name]
            );
            return true;
        } catch(e) { return false; }
    },

    deleteContact: async (id) => {
        if(!pool) return false;
        try {
            await pool.query('DELETE FROM wa_contacts WHERE id = ?', [id]);
            return true;
        } catch(e) { return false; }
    }
};
