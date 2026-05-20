const express = require('express');
const { Pool } = require('pg');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const nodemailer = require('nodemailer');

const app = express();
const PORT = process.env.PORT || 5000;
const SECRET_KEY = 'gse_inventory_secret_key_2024';

app.use(cors());
app.use(express.json());

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

let emailTransporter = null;

const setupEmail = async () => {
  try {
    const testAccount = await nodemailer.createTestAccount();
    emailTransporter = nodemailer.createTransport({
      host: 'smtp.ethereal.email',
      port: 587,
      secure: false,
      auth: { user: testAccount.user, pass: testAccount.pass }
    });
    console.log('Email system ready');
  } catch (err) {
    console.log('Email disabled');
  }
};
setupEmail();

const createTables = async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        username TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        full_name TEXT,
        role TEXT DEFAULT 'storekeeper',
        email TEXT
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS parts (
        id SERIAL PRIMARY KEY,
        part_number TEXT UNIQUE NOT NULL,
        description TEXT,
        manufacturer TEXT,
        compatible_gse TEXT,
        location_bin TEXT,
        quantity_on_hand INTEGER DEFAULT 0,
        min_stock INTEGER DEFAULT 5,
        contact_person TEXT,
        contact_phone TEXT,
        contact_email TEXT
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS transactions (
        id SERIAL PRIMARY KEY,
        part_id INTEGER REFERENCES parts(id),
        transaction_type TEXT NOT NULL,
        quantity INTEGER NOT NULL,
        gse_registration TEXT,
        technician_name TEXT,
        work_order TEXT,
        reference_number TEXT,
        created_by TEXT,
        notes TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    console.log('Tables created/verified');
  } catch (err) {
    console.error('Error creating tables:', err);
  }
};
createTables();

const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Access denied' });
  jwt.verify(token, SECRET_KEY, (err, user) => {
    if (err) return res.status(403).json({ error: 'Invalid token' });
    req.user = user;
    next();
  });
};

app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  try {
    const result = await pool.query('SELECT * FROM users WHERE username = $1', [username]);
    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    const user = result.rows[0];
    if (bcrypt.compareSync(password, user.password_hash)) {
      const token = jwt.sign({ id: user.id, username: user.username, role: user.role }, SECRET_KEY);
      res.json({ token, user: { id: user.id, username: user.username, full_name: user.full_name, role: user.role, email: user.email } });
    } else {
      res.status(401).json({ error: 'Invalid credentials' });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/parts', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM parts ORDER BY part_number');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/transactions/receive', authenticateToken, async (req, res) => {
  const { part_number, quantity, reference_number, notes } = req.body;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const partResult = await client.query('SELECT id, quantity_on_hand FROM parts WHERE part_number = $1', [part_number]);
    if (partResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Part not found' });
    }
    const part = partResult.rows[0];
    await client.query('INSERT INTO transactions (part_id, transaction_type, quantity, reference_number, notes, created_by) VALUES ($1, $2, $3, $4, $5, $6)', [part.id, 'RECEIVE', quantity, reference_number, notes, req.user.username]);
    await client.query('UPDATE parts SET quantity_on_hand = quantity_on_hand + $1 WHERE id = $2', [quantity, part.id]);
    await client.query('COMMIT');
    res.json({ message: 'Parts received successfully' });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

app.post('/api/transactions/issue', authenticateToken, async (req, res) => {
  const { part_number, quantity, gse_registration, technician_name, work_order, notes } = req.body;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const partResult = await client.query('SELECT id, quantity_on_hand FROM parts WHERE part_number = $1', [part_number]);
    if (partResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Part not found' });
    }
    const part = partResult.rows[0];
    if (part.quantity_on_hand < quantity) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Insufficient stock' });
    }
    await client.query('INSERT INTO transactions (part_id, transaction_type, quantity, gse_registration, technician_name, work_order, notes, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)', [part.id, 'ISSUE', quantity, gse_registration, technician_name, work_order, notes, req.user.username]);
    await client.query('UPDATE parts SET quantity_on_hand = quantity_on_hand - $1 WHERE id = $2', [quantity, part.id]);
    await client.query('COMMIT');
    res.json({ message: 'Parts issued successfully' });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

app.get('/api/transactions', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query('SELECT t.*, p.part_number, p.description FROM transactions t JOIN parts p ON t.part_id = p.id ORDER BY t.created_at DESC LIMIT 50');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/reports/low-stock', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query('SELECT part_number, description, quantity_on_hand, min_stock, location_bin FROM parts WHERE quantity_on_hand <= min_stock');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/parts', authenticateToken, async (req, res) => {
  const { part_number, description, manufacturer, compatible_gse, location_bin, min_stock, contact_person, contact_phone, contact_email } = req.body;
  try {
    const result = await pool.query('INSERT INTO parts (part_number, description, manufacturer, compatible_gse, location_bin, min_stock, quantity_on_hand, contact_person, contact_phone, contact_email) VALUES ($1, $2, $3, $4, $5, $6, 0, $7, $8, $9) RETURNING id', [part_number, description, manufacturer, compatible_gse, location_bin, min_stock || 5, contact_person, contact_phone, contact_email]);
    res.json({ id: result.rows[0].id, message: 'Part created successfully' });
  } catch (err) {
    if (err.constraint === 'parts_part_number_key') {
      res.status(500).json({ error: 'Part number already exists' });
    } else {
      res.status(500).json({ error: err.message });
    }
  }
});

app.put('/api/parts/:id', authenticateToken, async (req, res) => {
  const { contact_person, contact_phone, contact_email, location_bin, min_stock } = req.body;
  try {
    await pool.query('UPDATE parts SET contact_person = $1, contact_phone = $2, contact_email = $3, location_bin = $4, min_stock = $5 WHERE id = $6', [contact_person, contact_phone, contact_email, location_bin, min_stock, req.params.id]);
    res.json({ message: 'Part updated successfully' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/parts/:id', authenticateToken, async (req, res) => {
  if (req.user.role !== 'admin' && req.user.role !== 'manager') {
    return res.status(403).json({ error: 'Admin or Manager only' });
  }
  try {
    await pool.query('DELETE FROM parts WHERE id = $1', [req.params.id]);
    res.json({ message: 'Part deleted successfully' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/users', authenticateToken, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  try {
    const result = await pool.query('SELECT id, username, full_name, role, email FROM users');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/users', authenticateToken, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  const { username, password, full_name, role, email } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
  const password_hash = bcrypt.hashSync(password, 10);
  try {
    const result = await pool.query('INSERT INTO users (username, password_hash, full_name, role, email) VALUES ($1, $2, $3, $4, $5) RETURNING id', [username, password_hash, full_name, role || 'storekeeper', email || null]);
    res.json({ id: result.rows[0].id, message: 'User created successfully' });
  } catch (err) {
    res.status(500).json({ error: 'Username already exists' });
  }
});

app.put('/api/users/:id', authenticateToken, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  const { full_name, role, email } = req.body;
  try {
    await pool.query('UPDATE users SET full_name = $1, role = $2, email = $3 WHERE id = $4', [full_name, role, email, req.params.id]);
    res.json({ message: 'User updated successfully' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/users/:id', authenticateToken, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  if (req.params.id == req.user.id) return res.status(400).json({ error: 'Cannot delete your own account' });
  try {
    await pool.query('DELETE FROM users WHERE id = $1', [req.params.id]);
    res.json({ message: 'User deleted successfully' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/change-password', authenticateToken, async (req, res) => {
  const { current_password, new_password } = req.body;
  if (!current_password || !new_password) return res.status(400).json({ error: 'Current and new password required' });
  if (new_password.length < 4) return res.status(400).json({ error: 'Password must be at least 4 characters' });
  try {
    const result = await pool.query('SELECT password_hash FROM users WHERE id = $1', [req.user.id]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'User not found' });
    if (!bcrypt.compareSync(current_password, result.rows[0].password_hash)) {
      return res.status(401).json({ error: 'Current password is incorrect' });
    }
    const new_hash = bcrypt.hashSync(new_password, 10);
    await pool.query('UPDATE users SET password_hash = $1 WHERE id = $2', [new_hash, req.user.id]);
    res.json({ message: 'Password changed successfully! Please login again.' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update password' });
  }
});

app.post('/api/admin/reset-password', authenticateToken, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  const { user_id, new_password } = req.body;
  if (!user_id || !new_password) return res.status(400).json({ error: 'User ID and new password required' });
  if (new_password.length < 4) return res.status(400).json({ error: 'Password must be at least 4 characters' });
  const new_hash = bcrypt.hashSync(new_password, 10);
  try {
    await pool.query('UPDATE users SET password_hash = $1 WHERE id = $2', [new_hash, user_id]);
    res.json({ message: 'Password reset successfully!' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to reset password' });
  }
});

const resetCodes = new Map();

app.post('/api/forgot-password', async (req, res) => {
  const { username } = req.body;
  if (!username) return res.status(400).json({ error: 'Username is required' });
  try {
    const result = await pool.query('SELECT id, username, email FROM users WHERE username = $1', [username]);
    if (result.rows.length === 0) {
      return res.json({ message: 'If account exists, reset code has been sent.' });
    }
    const user = result.rows[0];
    const resetCode = Math.floor(100000 + Math.random() * 900000).toString();
    resetCodes.set(user.username, { code: resetCode, expires: Date.now() + 3600000 });
    console.log(`\nRESET CODE FOR ${username}: ${resetCode}`);
    if (user.email && emailTransporter) {
      emailTransporter.sendMail({
        from: '"GSE Inventory" <noreply@gse.com>',
        to: user.email,
        subject: 'Password Reset Code',
        html: `<h2>Your Reset Code: ${resetCode}</h2><p>Expires in 1 hour.</p>`
      }, (err) => {
        if (err) console.log(`Email error: ${err.message}`);
        else console.log(`Email sent to ${user.email}`);
      });
    }
    res.json({ message: 'Reset code sent!' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/reset-password', async (req, res) => {
  const { username, reset_code, new_password } = req.body;
  if (!username || !reset_code || !new_password) return res.status(400).json({ error: 'All fields required' });
  if (new_password.length < 4) return res.status(400).json({ error: 'Password must be at least 4 characters' });
  const stored = resetCodes.get(username);
  if (!stored || stored.code !== reset_code) return res.status(400).json({ error: 'Invalid reset code' });
  if (Date.now() > stored.expires) return res.status(400).json({ error: 'Reset code expired' });
  const new_hash = bcrypt.hashSync(new_password, 10);
  try {
    await pool.query('UPDATE users SET password_hash = $1 WHERE username = $2', [new_hash, username]);
    resetCodes.delete(username);
    res.json({ message: 'Password reset successfully!' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to reset password' });
  }
});

const createDefaultUsers = async () => {
  const defaultUsers = [
    ['admin', bcrypt.hashSync('admin123', 10), 'System Admin', 'admin', 'admin@example.com'],
    ['manager', bcrypt.hashSync('manager123', 10), 'GSE Manager', 'manager', 'manager@example.com'],
    ['storekeeper', bcrypt.hashSync('keeper123', 10), 'Store Keeper', 'storekeeper', 'storekeeper@example.com']
  ];
  for (const user of defaultUsers) {
    await pool.query('INSERT INTO users (username, password_hash, full_name, role, email) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (username) DO NOTHING', user);
  }
};
createDefaultUsers();

app.listen(PORT, () => {
  console.log(`GSE Server running on port ${PORT}`);
  console.log(`Login at http://localhost:3000`);
  console.log(`\nDefault Logins:`);
  console.log(`   admin / admin123 (Admin)`);
  console.log(`   manager / manager123 (Manager)`);
  console.log(`   storekeeper / keeper123 (Storekeeper)`);
});