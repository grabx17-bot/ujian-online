
const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const multer = require('multer');
const xlsx = require('xlsx');
const bcrypt = require('bcrypt');
const session = require('express-session');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

// Setup Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
    secret: 'ujian-online-secret-key-2026',
    resave: false,
    saveUninitialized: false
}));

// Setup SQLite Database
const dbFile = path.join(__dirname, 'database.sqlite');
const db = new sqlite3.Database(dbFile, (err) => {
    if (err) console.error('Error opening database', err.message);
    else console.log('Connected to SQLite database.');
});

// Initialize Tables
db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS exam_settings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        questions_per_time_block INTEGER DEFAULT 5,
        time_per_block INTEGER DEFAULT 60,
        passing_score INTEGER DEFAULT 75,
        randomize_questions INTEGER DEFAULT 1,
        randomize_options INTEGER DEFAULT 1
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS questions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        question TEXT NOT NULL,
        correct_answer TEXT NOT NULL,
        option_a TEXT NOT NULL,
        option_b TEXT NOT NULL,
        option_c TEXT NOT NULL,
        option_d TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS login_codes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        code TEXT UNIQUE NOT NULL,
        status TEXT DEFAULT 'Active',
        expires_at DATETIME,
        used_at DATETIME,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS attempts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        login_code_id INTEGER,
        started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        finished_at DATETIME,
        score REAL DEFAULT 0,
        correct_count INTEGER DEFAULT 0,
        wrong_count INTEGER DEFAULT 0,
        unanswered_count INTEGER DEFAULT 0,
        passed INTEGER DEFAULT 0,
        FOREIGN KEY (login_code_id) REFERENCES login_codes(id)
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS answers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        attempt_id INTEGER,
        question_id INTEGER,
        selected_answer TEXT,
        is_correct INTEGER DEFAULT 0,
        FOREIGN KEY (attempt_id) REFERENCES attempts(id),
        FOREIGN KEY (question_id) REFERENCES questions(id)
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS admins (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL
    )`, () => {
        // Default Admin: admin / admin123
        db.get("SELECT * FROM admins WHERE username = ?", ['admin'], async (err, row) => {
            if (!row) {
                const hash = await bcrypt.hash('admin123', 10);
                db.run("INSERT INTO admins (username, password_hash) VALUES (?, ?)", ['admin', hash]);
            }
        });
        // Default Settings
        db.get("SELECT * FROM exam_settings WHERE id = 1", (err, row) => {
            if (!row) {
                db.run("INSERT INTO exam_settings (questions_per_time_block, time_per_block, passing_score) VALUES (5, 60, 75)");
            }
        });
    });
});

// Multer for Excel Uploads
const upload = multer({ storage: multer.memoryStorage() });

// Helper: Generate Random Login Code
function generateCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let part1 = '';
    let part2 = '';
    for (let i = 0; i < 4; i++) {
        part1 += chars.charAt(Math.floor(Math.random() * chars.length));
        part2 += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return `${part1}-${part2}`;
}

// Helper: Shuffle Array
function shuffle(array) {
    for (let i = array.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [array[i], array[j]] = [array[j], array[i]];
    }
    return array;
}

// --- API ROUTES: PARTICIPANT ---

// Verify & Login Code
app.post('/api/participant/login', (req, res) => {
    let { code } = req.body;
    if (!code) return res.status(400).json({ error: 'Login Code diperlukan.' });
    code = code.trim().toUpperCase();

    db.get("SELECT * FROM login_codes WHERE code = ?", [code], (err, codeRow) => {
        if (!codeRow) return res.status(404).json({ error: 'Login Code tidak valid.' });
        if (codeRow.status === 'Used') return res.status(400).json({ error: 'Login Code ini sudah digunakan.' });
        if (codeRow.status === 'Expired' || (codeRow.expires_at && new Date() > new Date(codeRow.expires_at))) {
            return res.status(400).json({ error: 'Login Code ini sudah kedaluwarsa.' });
        }

        // Mark code as used & create attempt
        db.run("UPDATE login_codes SET status = 'Used', used_at = CURRENT_TIMESTAMP WHERE id = ?", [codeRow.id], function(err) {
            if (err) return res.status(500).json({ error: 'Database error' });

            db.run("INSERT INTO attempts (login_code_id) VALUES (?)", [codeRow.id], function(err) {
                if (err) return res.status(500).json({ error: 'Database error' });
                req.session.attemptId = this.lastID;
                req.session.loginCodeId = codeRow.id;
                res.json({ success: true, attemptId: this.lastID });
            });
        });
    });
});

// Get Exam Questions & Settings
app.get('/api/participant/exam-data', (req, res) => {
    if (!req.session.attemptId) return res.status(401).json({ error: 'Unauthorized' });

    db.get("SELECT * FROM exam_settings WHERE id = 1", (err, settings) => {
        db.all("SELECT id, question, correct_answer, option_a, option_b, option_c, option_d FROM questions", (err, questions) => {
            if (err) return res.status(500).json({ error: 'Database error' });

            // Randomize questions & options if enabled
            let processedQuestions = questions.map(q => {
                let options = [q.option_a, q.option_b, q.option_c, q.option_d];
                if (settings.randomize_options) {
                    options = shuffle(options);
                }
                return {
                    id: q.id,
                    question: q.question,
                    options: options
                };
            });

            if (settings.randomize_questions) {
                processedQuestions = shuffle(processedQuestions);
            }

            res.json({
                settings,
                questions: processedQuestions
            });
        });
    });
});

// Submit Exam
app.post('/api/participant/submit', (req, res) => {
    if (!req.session.attemptId) return res.status(401).json({ error: 'Unauthorized' });
    const { answers } = req.body; // Array of { questionId, selectedAnswer }
    const attemptId = req.session.attemptId;

    db.all("SELECT * FROM questions", (err, questions) => {
        if (err) return res.status(500).json({ error: 'Database error' });

        const questionMap = {};
        questions.forEach(q => questionMap[q.id] = q);

        let correctCount = 0;
        let wrongCount = 0;
        let answeredCount = 0;

        const stmt = db.prepare("INSERT INTO answers (attempt_id, question_id, selected_answer, is_correct) VALUES (?, ?, ?, ?)");

        answers.forEach(ans => {
            const q = questionMap[ans.questionId];
            if (!q) return;
            const isCorrect = (ans.selectedAnswer === q.correct_answer) ? 1 : 0;
            if (ans.selectedAnswer) answeredCount++;
            if (isCorrect) correctCount++;
            else if (ans.selectedAnswer) wrongCount++;

            stmt.run(attemptId, ans.questionId, ans.selectedAnswer || '', isCorrect);
        });
        stmt.finalize();

        const totalQuestions = questions.length;
        const unansweredCount = totalQuestions - answeredCount;
        const score = totalQuestions > 0 ? (correctCount / totalQuestions) * 100 : 0;

        db.get("SELECT passing_score FROM exam_settings WHERE id = 1", (err, settings) => {
            const passingScore = settings ? settings.passing_score : 75;
            const passed = score >= passingScore ? 1 : 0;

            db.run(`UPDATE attempts SET finished_at = CURRENT_TIMESTAMP, score = ?, correct_count = ?, wrong_count = ?, unanswered_count = ?, passed = ? WHERE id = ?`,
                [score, correctCount, wrongCount, unansweredCount, passed, attemptId], function(err) {
                    if (err) return res.status(500).json({ error: 'Database error' });
                    res.json({ success: true, score, correctCount, wrongCount, unansweredCount, passed });
                    delete req.session.attemptId;
                });
        });
    });
});

// --- API ROUTES: ADMIN ---

app.post('/api/admin/login', async (req, res) => {
    const { username, password } = req.body;
    db.get("SELECT * FROM admins WHERE username = ?", [username], async (err, admin) => {
        if (!admin) return res.status(401).json({ error: 'Username atau password salah.' });
        const match = await bcrypt.compare(password, admin.password_hash);
        if (!match) return res.status(401).json({ error: 'Username atau password salah.' });

        req.session.isAdmin = true;
        res.json({ success: true });
    });
});

app.get('/api/admin/check', (req, res) => {
    res.json({ isAdmin: !!req.session.isAdmin });
});

// Admin Middleware
function requireAdmin(req, res, next) {
    if (!req.session.isAdmin) return res.status(401).json({ error: 'Unauthorized Admin' });
    next();
}

// Generate Login Codes
app.post('/api/admin/codes/generate', requireAdmin, (req, res) => {
    const { count = 1, expires_at } = req.body;
    let generated = 0;

    function insertOne() {
        if (generated >= count) return res.json({ success: true, count });
        const code = generateCode();
        db.run("INSERT INTO login_codes (code, expires_at) VALUES (?, ?)", [code, expires_at || null], (err) => {
            if (err) {
                // Retry if duplicate
                insertOne();
            } else {
                generated++;
                insertOne();
            }
        });
    }
    insertOne();
});

app.get('/api/admin/codes', requireAdmin, (req, res) => {
    db.all("SELECT * FROM login_codes ORDER BY id DESC", (err, rows) => {
        res.json(rows);
    });
});

app.delete('/api/admin/codes/:id', requireAdmin, (req, res) => {
    db.run("DELETE FROM login_codes WHERE id = ?", [req.params.id], (err) => {
        res.json({ success: true });
    });
});

// Import Excel Questions
app.post('/api/admin/questions/import', requireAdmin, upload.single('file'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'File Excel tidak ditemukan.' });

    try {
        const workbook = xlsx.read(req.file.buffer, { type: 'buffer' });
        const sheetName = workbook.SheetNames[0];
        const sheet = workbook.Sheets[sheetName];
        const data = xlsx.utils.sheet_to_json(sheet, { header: 1 });

        let importedCount = 0;
        const dummyDistractors = ['Bandung', 'Surabaya', 'Medan', 'Semarang', 'Yogyakarta', 'Bali', 'Makassar'];

        data.forEach(row => {
            const question = row[0];
            const correctAnswer = row[1];

            if (!question || !correctAnswer) return; // Skip empty rows

            // Generate 3 unique distractors
            let options = [String(correctAnswer)];
            while (options.length < 4) {
                let randomDistractor = dummyDistractors[Math.floor(Math.random() * dummyDistractors.length)];
                if (!options.includes(randomDistractor) && randomDistractor !== String(correctAnswer)) {
                    options.push(randomDistractor);
                }
            }
            options = shuffle(options);

            db.run("INSERT INTO questions (question, correct_answer, option_a, option_b, option_c, option_d) VALUES (?, ?, ?, ?, ?, ?)",
                [String(question), String(correctAnswer), options[0], options[1], options[2], options[3]]);
            importedCount++;
        });

        res.json({ success: true, importedCount });
    } catch (e) {
        res.status(500).json({ error: 'Gagal memproses file Excel: ' + e.message });
    }
});

app.get('/api/admin/questions', requireAdmin, (req, res) => {
    db.all("SELECT * FROM questions ORDER BY id DESC", (err, rows) => res.json(rows));
});

app.delete('/api/admin/questions/:id', requireAdmin, (req, res) => {
    db.run("DELETE FROM questions WHERE id = ?", [req.params.id], (err) => res.json({ success: true }));
});

// Exam Settings API
app.get('/api/admin/settings', requireAdmin, (req, res) => {
    db.get("SELECT * FROM exam_settings WHERE id = 1", (err, row) => res.json(row));
});

app.post('/api/admin/settings', requireAdmin, (req, res) => {
    const { questions_per_time_block, time_per_block, passing_score, randomize_questions, randomize_options } = req.body;
    db.run("UPDATE exam_settings SET questions_per_time_block = ?, time_per_block = ?, passing_score = ?, randomize_questions = ?, randomize_options = ? WHERE id = 1",
        [questions_per_time_block, time_per_block, passing_score, randomize_questions, randomize_options], (err) => {
            res.json({ success: true });
        });
});

// Results Reports API
app.get('/api/admin/results', requireAdmin, (req, res) => {
    const query = `
        SELECT attempts.*, login_codes.code 
        FROM attempts 
        JOIN login_codes ON attempts.login_code_id = login_codes.id 
        ORDER BY attempts.id DESC
    `;
    db.all(query, (err, rows) => res.json(rows));
});

app.get('/api/admin/results/:id', requireAdmin, (req, res) => {
    const attemptId = req.params.id;
    db.get("SELECT attempts.*, login_codes.code FROM attempts JOIN login_codes ON attempts.login_code_id = login_codes.id WHERE attempts.id = ?", [attemptId], (err, attempt) => {
        if (!attempt) return res.status(404).json({ error: 'Data tidak ditemukan' });

        db.all(`
            SELECT answers.*, questions.question, questions.correct_answer 
            FROM answers 
            JOIN questions ON answers.question_id = questions.id 
            WHERE answers.attempt_id = ?
        `, [attemptId], (err, answers) => {
            res.json({ attempt, answers });
        });
    });
});

app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});