require('dotenv').config();

const express = require('express');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const session = require('express-session');
const multer = require('multer');
const { Pool } = require('pg');
const sqlite3 = require('sqlite3').verbose();

const app = express();
const PORT = process.env.PORT || 3000;
const useSQLite = !process.env.DATABASE_URL || process.env.DATABASE_URL.startsWith('sqlite');
let pool = null;
let db = null;

if (useSQLite) {
  db = new sqlite3.Database(path.join(__dirname, 'lifeadmin.db'));
} else {
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  });
}

const upload = multer({ dest: path.join(__dirname, 'uploads') });

function normalizeSqliteSql(sql) {
  return sql.replace(/\$(\d+)/g, '?');
}

function normalizePostgresSql(sql) {
  let parameterIndex = 0;
  return sql.replace(/\?/g, () => `$${++parameterIndex}`);
}

function queryDb(sql, params = []) {
  const normalizedSql = useSQLite ? normalizeSqliteSql(sql) : normalizePostgresSql(sql);

  if (useSQLite) {
    return new Promise((resolve, reject) => {
      db.all(normalizedSql, params, (err, rows) => {
        if (err) {
          reject(err);
          return;
        }
        resolve({ rows: rows || [], rowCount: rows ? rows.length : 0 });
      });
    });
  }

  return pool.query(normalizedSql, params);
}

function execDb(sql, params = []) {
  const normalizedSql = useSQLite ? normalizeSqliteSql(sql) : normalizePostgresSql(sql);

  if (useSQLite) {
    return new Promise((resolve, reject) => {
      db.run(normalizedSql, params, function (err) {
        if (err) {
          reject(err);
          return;
        }

        resolve({ rows: [{ id: this.lastID }], rowCount: 1 });
      });
    });
  }

  return pool.query(normalizedSql, params);
}

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use(
  session({
    secret: process.env.SESSION_SECRET || 'lifeadmin-secret',
    resave: false,
    saveUninitialized: false,
    cookie: { httpOnly: true, maxAge: 1000 * 60 * 60 * 12 },
  })
);

app.use((req, res, next) => {
  res.locals.user = req.session.user || null;
  next();
});

async function ensureDatabase() {
  if (useSQLite) {
    const sqliteSchema = `
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        email TEXT UNIQUE NOT NULL,
        password TEXT NOT NULL,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS urusan (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        category TEXT NOT NULL,
        name TEXT NOT NULL,
        description TEXT,
        due_date TEXT NOT NULL,
        recurring_type TEXT DEFAULT 'one-time',
        reminder_days TEXT DEFAULT '3,1',
        status TEXT DEFAULT 'active',
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS reminders (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        urusan_id INTEGER REFERENCES urusan(id) ON DELETE CASCADE,
        days_before INTEGER NOT NULL,
        status TEXT DEFAULT 'pending'
      );

      CREATE TABLE IF NOT EXISTS documents (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        urusan_id INTEGER REFERENCES urusan(id) ON DELETE CASCADE,
        file_name TEXT,
        file_path TEXT NOT NULL,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS notifications (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        urusan_id INTEGER REFERENCES urusan(id) ON DELETE CASCADE,
        message TEXT NOT NULL,
        status TEXT DEFAULT 'unread',
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
      );
    `;

    await new Promise((resolve, reject) => {
      db.exec(sqliteSchema, (err) => (err ? reject(err) : resolve()));
    });

    return;
  }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      name VARCHAR(100) NOT NULL,
      email VARCHAR(150) UNIQUE NOT NULL,
      password TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS urusan (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      category VARCHAR(50) NOT NULL,
      name VARCHAR(150) NOT NULL,
      description TEXT,
      due_date DATE NOT NULL,
      recurring_type VARCHAR(50) DEFAULT 'one-time',
      reminder_days TEXT DEFAULT '3,1',
      status VARCHAR(30) DEFAULT 'active',
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS reminders (
      id SERIAL PRIMARY KEY,
      urusan_id INTEGER REFERENCES urusan(id) ON DELETE CASCADE,
      days_before INTEGER NOT NULL,
      status VARCHAR(30) DEFAULT 'pending'
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS documents (
      id SERIAL PRIMARY KEY,
      urusan_id INTEGER REFERENCES urusan(id) ON DELETE CASCADE,
      file_name VARCHAR(255),
      file_path TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS notifications (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      urusan_id INTEGER REFERENCES urusan(id) ON DELETE CASCADE,
      message TEXT NOT NULL,
      status VARCHAR(30) DEFAULT 'unread',
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);
}

function requireAuth(req, res, next) {
  if (!req.session.user) return res.redirect('/login');
  next();
}

function getUrgencyLabel(dueDate) {
  const today = new Date();
  const target = new Date(dueDate);
  const diff = Math.ceil((target - today) / (1000 * 60 * 60 * 24));

  if (diff <= 3) return 'urgent';
  if (diff <= 14) return 'soon';
  if (diff <= 30) return 'upcoming';
  return 'safe';
}

function getTaskSummary(tasks) {
  return {
    total: tasks.length,
    urgent: tasks.filter((task) => getUrgencyLabel(task.due_date) === 'urgent').length,
    soon: tasks.filter((task) => getUrgencyLabel(task.due_date) === 'soon').length,
    upcoming: tasks.filter((task) => getUrgencyLabel(task.due_date) === 'upcoming').length,
    safe: tasks.filter((task) => getUrgencyLabel(task.due_date) === 'safe').length,
  };
}

app.get('/', (req, res) => {
  res.render('home', { title: 'LifeSaver', supportEmail: process.env.SUPPORT_EMAIL || null });
});

app.get('/register', (req, res) => {
  res.render('register', { title: 'Register' });
});

app.post('/register', async (req, res) => {
  const { name, email, password, confirmPassword } = req.body;

  if (!name || !email || !password) {
    return res.status(400).render('register', {
      title: 'Register',
      error: 'Semua field wajib diisi.',
    });
  }

  if (password.length < 8) {
    return res.status(400).render('register', {
      title: 'Register',
      error: 'Password minimal 8 karakter.',
    });
  }

  if (password !== confirmPassword) {
    return res.status(400).render('register', {
      title: 'Register',
      error: 'Konfirmasi password tidak cocok.',
    });
  }

  try {
    const existing = await queryDb('SELECT id FROM users WHERE email = ?', [email.toLowerCase()]);
    if (existing.rowCount > 0) {
      return res.status(400).render('register', {
        title: 'Register',
        error: 'Email sudah terdaftar.',
      });
    }

    const hash = await bcrypt.hash(password, 10);
    const result = await execDb(
      'INSERT INTO users (name, email, password) VALUES (?, ?, ?)',
      [name, email.toLowerCase(), hash]
    );

    const userResult = await queryDb('SELECT id, name, email FROM users WHERE email = ?', [email.toLowerCase()]);
    req.session.user = userResult.rows[0];
    res.redirect('/dashboard');
  } catch (error) {
    console.error(error);
    res.status(500).render('register', {
      title: 'Register',
      error: 'Terjadi kesalahan saat registrasi.',
    });
  }
});

app.get('/login', (req, res) => {
  res.render('login', { title: 'Login', error: null });
});

app.post('/login', async (req, res) => {
  const { email, password } = req.body;

  try {
    const result = await queryDb('SELECT * FROM users WHERE email = ?', [email.toLowerCase()]);
    const user = result.rows[0];

    if (!user) {
      return res.status(401).render('login', {
        title: 'Login',
        error: 'Email atau password salah.',
      });
    }

    const valid = await bcrypt.compare(password, user.password);
    if (!valid) {
      return res.status(401).render('login', {
        title: 'Login',
        error: 'Email atau password salah.',
      });
    }

    req.session.user = { id: user.id, name: user.name, email: user.email };
    res.redirect('/dashboard');
  } catch (error) {
    console.error(error);
    res.status(500).render('login', {
      title: 'Login',
      error: 'Terjadi kesalahan saat login.',
    });
  }
});

app.get('/logout', (req, res) => {
  req.session.destroy(() => {
    res.redirect('/');
  });
});

app.get('/dashboard', requireAuth, async (req, res) => {
  try {
    const tasks = await queryDb('SELECT * FROM urusan WHERE user_id = ? ORDER BY due_date ASC', [req.session.user.id]);

    const list = tasks.rows.map((task) => ({
      ...task,
      urgency: getUrgencyLabel(task.due_date),
    }));

    const summary = getTaskSummary(list);
    const todayTasks = list.filter((task) => getUrgencyLabel(task.due_date) === 'urgent');
    const nextTask = list[0] || null;
    const upcomingTasks = list.slice(0, 3);

    res.render('dashboard', {
      title: 'Dashboard',
      tasks: list,
      summary,
      todayTasks,
      nextTask,
      upcomingTasks,
    });
  } catch (error) {
    console.error(error);
    res.status(500).send('Gagal memuat dashboard');
  }
});

app.get('/urusan/new', requireAuth, (req, res) => {
  res.render('add-urusan', { title: 'Tambah Urusan', error: null });
});

app.post('/urusan/new', requireAuth, async (req, res) => {
  const { category, name, description, due_date, recurring_type, reminder_days } = req.body;

  if (!category || !name || !due_date) {
    return res.status(400).render('add-urusan', {
      title: 'Tambah Urusan',
      error: 'Kategori, nama, dan tanggal jatuh tempo wajib diisi.',
    });
  }

  try {
    const insertTask = await execDb(
      `INSERT INTO urusan (user_id, category, name, description, due_date, recurring_type, reminder_days)
       VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id`,
      [req.session.user.id, category, name, description || '', due_date, recurring_type || 'one-time', reminder_days || '3,1']
    );

    const urusanId = insertTask.rows[0].id;
    const reminderValues = (reminder_days || '3,1')
      .split(',')
      .map((value) => Number(value.trim()))
      .filter((value) => Number.isInteger(value) && value > 0);

    if (reminderValues.length === 0) {
      await execDb('INSERT INTO reminders (urusan_id, days_before, status) VALUES (?, ?, ?)', [urusanId, 3, 'pending']);
    } else {
      for (const days of reminderValues) {
        await execDb('INSERT INTO reminders (urusan_id, days_before, status) VALUES (?, ?, ?)', [urusanId, days, 'pending']);
      }
    }

    await execDb(
      'INSERT INTO notifications (user_id, urusan_id, message, status) VALUES (?, ?, ?, ?)',
      [
        req.session.user.id,
        urusanId,
        `${name} perlu diperhatikan pada tanggal ${due_date}.`,
        'unread',
      ]
    );

    res.redirect('/dashboard');
  } catch (error) {
    console.error(error);
    res.status(500).render('add-urusan', {
      title: 'Tambah Urusan',
      error: 'Terjadi kesalahan saat menyimpan urusan.',
    });
  }
});

app.get('/urusan/:id', requireAuth, async (req, res) => {
  try {
    const taskResult = await queryDb('SELECT * FROM urusan WHERE id = ? AND user_id = ?', [req.params.id, req.session.user.id]);
    const task = taskResult.rows[0];

    if (!task) {
      return res.redirect('/dashboard');
    }

    const documentResult = await queryDb('SELECT * FROM documents WHERE urusan_id = ? ORDER BY created_at DESC', [req.params.id]);
    const reminderResult = await queryDb('SELECT * FROM reminders WHERE urusan_id = ? ORDER BY days_before ASC', [req.params.id]);

    res.render('detail-urusan', {
      title: 'Detail Urusan',
      task: { ...task, urgency: getUrgencyLabel(task.due_date) },
      documents: documentResult.rows,
      reminders: reminderResult.rows,
    });
  } catch (error) {
    console.error(error);
    res.status(500).send('Gagal memuat detail urusan');
  }
});

app.get('/urusan/:id/edit', requireAuth, async (req, res) => {
  try {
    const taskResult = await queryDb('SELECT * FROM urusan WHERE id = ? AND user_id = ?', [req.params.id, req.session.user.id]);
    const task = taskResult.rows[0];

    if (!task) {
      return res.redirect('/dashboard');
    }

    res.render('edit-urusan', {
      title: 'Edit Urusan',
      task,
      error: null,
    });
  } catch (error) {
    console.error(error);
    res.status(500).send('Gagal memuat form edit');
  }
});

app.post('/urusan/:id/edit', requireAuth, async (req, res) => {
  const { category, name, description, due_date, recurring_type, reminder_days } = req.body;

  if (!category || !name || !due_date) {
    return res.status(400).render('edit-urusan', {
      title: 'Edit Urusan',
      task: { id: req.params.id, category, name, description, due_date, recurring_type, reminder_days },
      error: 'Kategori, nama, dan tanggal jatuh tempo wajib diisi.',
    });
  }

  try {
    const ownedTask = await queryDb('SELECT id FROM urusan WHERE id = ? AND user_id = ?', [req.params.id, req.session.user.id]);
    if (!ownedTask.rows.length) {
      return res.status(404).send('Urusan tidak ditemukan');
    }

    await execDb(
      `UPDATE urusan
       SET category = ?, name = ?, description = ?, due_date = ?, recurring_type = ?, reminder_days = ?
       WHERE id = ? AND user_id = ?`,
      [category, name, description || '', due_date, recurring_type || 'one-time', reminder_days || '3,1', req.params.id, req.session.user.id]
    );

    await execDb('DELETE FROM reminders WHERE urusan_id = ?', [req.params.id]);

    const reminderValues = (reminder_days || '3,1')
      .split(',')
      .map((value) => Number(value.trim()))
      .filter((value) => Number.isInteger(value) && value > 0);

    if (reminderValues.length > 0) {
      for (const days of reminderValues) {
        await execDb('INSERT INTO reminders (urusan_id, days_before, status) VALUES (?, ?, ?)', [req.params.id, days, 'pending']);
      }
    } else {
      await execDb('INSERT INTO reminders (urusan_id, days_before, status) VALUES (?, ?, ?)', [req.params.id, 3, 'pending']);
    }

    res.redirect(`/urusan/${req.params.id}`);
  } catch (error) {
    console.error(error);
    res.status(500).render('edit-urusan', {
      title: 'Edit Urusan',
      task: { id: req.params.id, category, name, description, due_date, recurring_type, reminder_days },
      error: 'Terjadi kesalahan saat memperbarui urusan.',
    });
  }
});

app.post('/urusan/:id/upload', requireAuth, upload.single('document'), async (req, res) => {
  try {
    const ownedTask = await queryDb('SELECT id FROM urusan WHERE id = ? AND user_id = ?', [req.params.id, req.session.user.id]);
    if (!ownedTask.rows.length) {
      if (req.file) await fs.promises.unlink(req.file.path).catch(() => {});
      return res.status(404).send('Urusan tidak ditemukan');
    }

    if (!req.file) {
      return res.redirect(`/urusan/${req.params.id}`);
    }

    const fileName = req.file.originalname || req.file.filename;
    const filePath = `/uploads/${req.file.filename}`;
    await execDb('INSERT INTO documents (urusan_id, file_name, file_path) VALUES (?, ?, ?)', [req.params.id, fileName, filePath]);
    res.redirect(`/urusan/${req.params.id}`);
  } catch (error) {
    console.error(error);
    if (req.file) await fs.promises.unlink(req.file.path).catch(() => {});
    res.redirect(`/urusan/${req.params.id}`);
  }
});

app.get('/documents/:id/download', requireAuth, async (req, res) => {
  try {
    const docResult = await queryDb(
      `SELECT d.file_name, d.file_path
       FROM documents d
       JOIN urusan u ON u.id = d.urusan_id
       WHERE d.id = ? AND u.user_id = ?`,
      [req.params.id, req.session.user.id]
    );
    const doc = docResult.rows[0];

    if (!doc) {
      return res.status(404).send('Dokumen tidak ditemukan');
    }

    const filePath = path.join(__dirname, 'uploads', path.basename(doc.file_path));
    res.download(filePath, doc.file_name, (error) => {
      if (error && !res.headersSent) res.status(error.statusCode || 404).send('Dokumen tidak ditemukan');
    });
  } catch (error) {
    console.error(error);
    res.status(500).send('Gagal mengunduh dokumen');
  }
});

app.post('/documents/:id/delete', requireAuth, async (req, res) => {
  try {
    const docResult = await queryDb(
      `SELECT d.urusan_id, d.file_path
       FROM documents d
       JOIN urusan u ON u.id = d.urusan_id
       WHERE d.id = ? AND u.user_id = ?`,
      [req.params.id, req.session.user.id]
    );
    const doc = docResult.rows[0];

    if (!doc) {
      return res.status(404).send('Dokumen tidak ditemukan');
    }

    await execDb('DELETE FROM documents WHERE id = ?', [req.params.id]);
    await fs.promises.unlink(path.join(__dirname, 'uploads', path.basename(doc.file_path))).catch((error) => {
      if (error.code !== 'ENOENT') throw error;
    });
    res.redirect(`/urusan/${doc.urusan_id}`);
  } catch (error) {
    console.error(error);
    res.redirect('/dashboard');
  }
});

app.get('/timeline', requireAuth, async (req, res) => {
  try {
    const tasks = await queryDb('SELECT * FROM urusan WHERE user_id = ? ORDER BY due_date ASC', [req.session.user.id]);

    const list = tasks.rows.map((task) => ({
      ...task,
      urgency: getUrgencyLabel(task.due_date),
    }));

    res.render('timeline', { title: 'Timeline', tasks: list });
  } catch (error) {
    console.error(error);
    res.status(500).send('Gagal memuat timeline');
  }
});

app.get('/notifications', requireAuth, async (req, res) => {
  try {
    const result = await queryDb(
      `SELECT n.*, u.name AS urusan_name
       FROM notifications n
       LEFT JOIN urusan u ON u.id = n.urusan_id
       WHERE n.user_id = ?
       ORDER BY n.created_at DESC`,
      [req.session.user.id]
    );

    res.render('notifications', { title: 'Notifikasi', notifications: result.rows });
  } catch (error) {
    console.error(error);
    res.status(500).send('Gagal memuat notifikasi');
  }
});

app.post('/urusan/:id/delete', requireAuth, async (req, res) => {
  try {
    const ownedTask = await queryDb('SELECT id FROM urusan WHERE id = ? AND user_id = ?', [req.params.id, req.session.user.id]);
    if (!ownedTask.rows.length) {
      return res.status(404).send('Urusan tidak ditemukan');
    }

    await execDb('DELETE FROM urusan WHERE id = ? AND user_id = ?', [req.params.id, req.session.user.id]);
    res.redirect('/dashboard');
  } catch (error) {
    console.error(error);
    res.redirect('/dashboard');
  }
});

app.use((req, res) => {
  res.status(404).send('Halaman tidak ditemukan');
});

async function startServer() {
  try {
    fs.mkdirSync(path.join(__dirname, 'uploads'), { recursive: true });
    await ensureDatabase();
    app.listen(PORT, () => {
      console.log(`LifeSaver running at http://localhost:${PORT}`);
    });
  } catch (error) {
    console.error('Failed to initialize database:', error);
    process.exit(1);
  }
}

startServer();