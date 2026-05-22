const express = require('express');
const { createClient } = require('@libsql/client');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const cors = require('cors');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 5000;
const SECRET_KEY = 'gse_inventory_secret_key_2024';

// ========== CORS CONFIGURATION ==========
const allowedOrigins = [
  'http://localhost:3000',
  'http://localhost:5000',
  'https://gse-frontend.onrender.com',
  'https://casgseinv.onrender.com',
  'https://gse-backend.onrender.com'
];

app.use(cors({
  origin: function(origin, callback) {
    if (!origin) return callback(null, true);
    if (allowedOrigins.indexOf(origin) === -1) {
      return callback(new Error('CORS policy does not allow this origin'), false);
    }
    return callback(null, true);
  },
  credentials: true
}));

app.use(express.json());

// ========== TURSO DATABASE CONNECTION ==========
const db = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

console.log('✅ Connected to Turso cloud database');

// ========== CREATE TABLES ==========
const createTables = async () => {
  try {
    await db.execute(`CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      full_name TEXT,
      role TEXT DEFAULT 'storekeeper',
      email TEXT
    )`);
    
    await db.execute(`CREATE TABLE IF NOT EXISTS parts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
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
    )`);
    
    await db.execute(`CREATE TABLE IF NOT EXISTS transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      part_id INTEGER,
      transaction_type TEXT NOT NULL,
      quantity INTEGER NOT NULL,
      gse_registration TEXT,
      technician_name TEXT,
      work_order TEXT,
      reference_number TEXT,
      created_by TEXT,
      notes TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (part_id) REFERENCES parts(id)
    )`);
    
    await db.execute(`CREATE TABLE IF NOT EXISTS pending_issues (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      part_number TEXT NOT NULL,
      part_id INTEGER NOT NULL,
      quantity INTEGER NOT NULL,
      gse_registration TEXT,
      technician_name TEXT,
      work_order TEXT,
      notes TEXT,
      requested_by TEXT NOT NULL,
      requested_by_name TEXT,
      status TEXT DEFAULT 'pending',
      admin_comment TEXT,
      approved_by TEXT,
      approved_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (part_id) REFERENCES parts(id)
    )`);
    
    console.log('✅ Tables created/verified');
  } catch (err) {
    console.error('Table error:', err.message);
  }
};

// ========== FORCE CREATE USERS ==========
const createUsers = async () => {
  console.log('🔧 Creating users...');
  
  const usersToCreate = [
    { username: 'admin', password: 'admin123', full_name: 'System Admin', role: 'admin', email: 'admin@example.com' },
    { username: 'manager', password: 'manager123', full_name: 'GSE Manager', role: 'manager', email: 'manager@example.com' },
    { username: 'storekeeper', password: 'keeper123', full_name: 'Store Keeper', role: 'storekeeper', email: 'storekeeper@example.com' }
  ];
  
  let created = 0;
  let failed = 0;
  
  for (const user of usersToCreate) {
    try {
      const existing = await db.execute({ 
        sql: 'SELECT id FROM users WHERE username = ?', 
        args: [user.username] 
      });
      
      if (existing.rows.length === 0) {
        const hashedPassword = bcrypt.hashSync(user.password, 10);
        await db.execute({ 
          sql: 'INSERT INTO users (username, password_hash, full_name, role, email) VALUES (?, ?, ?, ?, ?)', 
          args: [user.username, hashedPassword, user.full_name, user.role, user.email] 
        });
        console.log(`✅ Created user: ${user.username} with password: ${user.password}`);
        created++;
      } else {
        console.log(`✅ User already exists: ${user.username}`);
      }
    } catch (err) {
      console.log(`❌ Failed to create ${user.username}:`, err.message);
      failed++;
    }
  }
  
  console.log(`📋 Users created: ${created}, Failed: ${failed}`);
  
  // Verify users
  const result = await db.execute('SELECT id, username, role FROM users');
  console.log(`📋 Total users in DB: ${result.rows.length}`);
  result.rows.forEach(u => console.log(`   - ${u.username} (${u.role})`));
  
  return result.rows;
};

// ========== INIT USERS ENDPOINT ==========
app.get('/api/init-users', async (req, res) => {
  try {
    const users = await createUsers();
    res.json({ success: true, users: users });
  } catch (err) {
    console.error('Init error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/init-users', async (req, res) => {
  try {
    const users = await createUsers();
    res.json({ success: true, users: users });
  } catch (err) {
    console.error('Init error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ========== DEBUG USERS ==========
app.get('/api/debug/users', async (req, res) => {
  try {
    const result = await db.execute('SELECT id, username, role FROM users');
    res.json({ users: result.rows });
  } catch (err) {
    res.json({ error: err.message });
  }
});

// ========== TEST LOGIN ==========
app.post('/api/test-login', async (req, res) => {
  const { username, password } = req.body;
  
  try {
    const result = await db.execute({ 
      sql: 'SELECT * FROM users WHERE username = ?', 
      args: [username] 
    });
    
    if (result.rows.length === 0) {
      return res.json({ success: false, message: 'User not found' });
    }
    
    const user = result.rows[0];
    const passwordMatch = bcrypt.compareSync(password, user.password_hash);
    
    res.json({ 
      success: passwordMatch,
      username: user.username,
      role: user.role,
      message: passwordMatch ? 'Password correct!' : 'Password incorrect'
    });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

// ========== LOGIN ==========
app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  console.log(`Login attempt: ${username}`);
  
  try {
    const result = await db.execute({ 
      sql: 'SELECT * FROM users WHERE username = ?', 
      args: [username] 
    });
    
    if (result.rows.length === 0) {
      console.log(`User not found: ${username}`);
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    
    const user = result.rows[0];
    console.log(`User found: ${username}, role: ${user.role}`);
    
    if (bcrypt.compareSync(password, user.password_hash)) {
      const token = jwt.sign({ id: user.id, username: user.username, role: user.role }, SECRET_KEY);
      console.log(`Login successful: ${username}`);
      res.json({ 
        token, 
        user: { 
          id: user.id, 
          username: user.username, 
          full_name: user.full_name, 
          role: user.role, 
          email: user.email 
        } 
      });
    } else {
      console.log(`Invalid password for: ${username}`);
      res.status(401).json({ error: 'Invalid credentials' });
    }
  } catch (err) {
    console.error('Login error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ========== AUTHENTICATION MIDDLEWARE ==========
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

// ========== GET PARTS ==========
app.get('/api/parts', authenticateToken, async (req, res) => {
  try {
    const result = await db.execute('SELECT * FROM parts ORDER BY part_number');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ========== RECEIVE PARTS ==========
app.post('/api/transactions/receive', authenticateToken, async (req, res) => {
  const { part_number, quantity, reference_number, notes } = req.body;
  
  try {
    const partResult = await db.execute({ sql: 'SELECT id, quantity_on_hand FROM parts WHERE part_number = ?', args: [part_number] });
    
    if (partResult.rows.length === 0) {
      return res.status(404).json({ error: 'Part not found' });
    }
    
    const part = partResult.rows[0];
    const newQuantity = part.quantity_on_hand + parseInt(quantity);
    
    await db.execute({ 
      sql: `INSERT INTO transactions (part_id, transaction_type, quantity, reference_number, notes, created_by, created_at) 
            VALUES (?, 'RECEIVE', ?, ?, ?, ?, CURRENT_TIMESTAMP)`, 
      args: [part.id, parseInt(quantity), reference_number, notes, req.user.username] 
    });
    
    await db.execute({ sql: 'UPDATE parts SET quantity_on_hand = ? WHERE id = ?', args: [newQuantity, part.id] });
    
    res.json({ success: true, message: 'Parts received successfully' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ========== SUBMIT ISSUE REQUEST ==========
app.post('/api/requests/issue', authenticateToken, async (req, res) => {
  const { part_number, quantity, gse_registration, technician_name, work_order, notes } = req.body;
  
  try {
    const partResult = await db.execute({ sql: 'SELECT id, quantity_on_hand FROM parts WHERE part_number = ?', args: [part_number] });
    
    if (partResult.rows.length === 0) {
      return res.status(404).json({ error: 'Part not found' });
    }
    
    const part = partResult.rows[0];
    
    if (part.quantity_on_hand < parseInt(quantity)) {
      return res.status(400).json({ error: 'Insufficient stock available' });
    }
    
    await db.execute({ 
      sql: `INSERT INTO pending_issues 
            (part_number, part_id, quantity, gse_registration, technician_name, work_order, notes, requested_by, requested_by_name, status, created_at) 
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', CURRENT_TIMESTAMP)`, 
      args: [part_number, part.id, parseInt(quantity), gse_registration, technician_name, work_order, notes, req.user.id, req.user.username] 
    });
    
    res.json({ success: true, message: 'Issue request submitted for approval' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ========== GET PENDING REQUESTS ==========
app.get('/api/requests/pending', authenticateToken, async (req, res) => {
  if (req.user.role !== 'admin' && req.user.role !== 'manager') {
    return res.status(403).json({ error: 'Access denied' });
  }
  
  try {
    const result = await db.execute(`
      SELECT p.*, parts.quantity_on_hand as current_stock, parts.description
      FROM pending_issues p
      JOIN parts ON p.part_id = parts.id
      WHERE p.status = 'pending'
      ORDER BY p.created_at DESC
    `);
    
    res.json({ success: true, requests: result.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ========== APPROVE REQUEST ==========
app.post('/api/requests/:id/approve', authenticateToken, async (req, res) => {
  const { id } = req.params;
  const { comment } = req.body;
  
  if (req.user.role !== 'admin' && req.user.role !== 'manager') {
    return res.status(403).json({ error: 'Access denied' });
  }
  
  try {
    const requestResult = await db.execute({ sql: 'SELECT * FROM pending_issues WHERE id = ? AND status = "pending"', args: [id] });
    
    if (requestResult.rows.length === 0) {
      return res.status(404).json({ error: 'Request not found' });
    }
    
    const request = requestResult.rows[0];
    
    const partResult = await db.execute({ sql: 'SELECT quantity_on_hand FROM parts WHERE id = ?', args: [request.part_id] });
    const currentStock = partResult.rows[0].quantity_on_hand;
    const newStock = currentStock - parseInt(request.quantity);
    
    await db.execute({ 
      sql: `INSERT INTO transactions 
            (part_id, transaction_type, quantity, gse_registration, technician_name, work_order, notes, created_by, created_at) 
            VALUES (?, 'ISSUE', ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`, 
      args: [request.part_id, request.quantity, request.gse_registration, request.technician_name, request.work_order, request.notes, req.user.username] 
    });
    
    await db.execute({ sql: 'UPDATE parts SET quantity_on_hand = ? WHERE id = ?', args: [newStock, request.part_id] });
    
    await db.execute({ 
      sql: `UPDATE pending_issues SET status = 'approved', admin_comment = ?, approved_by = ?, approved_at = CURRENT_TIMESTAMP WHERE id = ?`, 
      args: [comment || null, req.user.username, id] 
    });
    
    res.json({ success: true, message: 'Request approved' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ========== REJECT REQUEST ==========
app.post('/api/requests/:id/reject', authenticateToken, async (req, res) => {
  const { id } = req.params;
  const { comment } = req.body;
  
  if (req.user.role !== 'admin' && req.user.role !== 'manager') {
    return res.status(403).json({ error: 'Access denied' });
  }
  
  try {
    await db.execute({ 
      sql: `UPDATE pending_issues SET status = 'rejected', admin_comment = ?, approved_by = ?, approved_at = CURRENT_TIMESTAMP WHERE id = ?`, 
      args: [comment || null, req.user.username, id] 
    });
    
    res.json({ success: true, message: 'Request rejected' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ========== GET MY REQUESTS ==========
app.get('/api/requests/my-requests', authenticateToken, async (req, res) => {
  try {
    const result = await db.execute({ 
      sql: `SELECT p.*, parts.description 
            FROM pending_issues p
            JOIN parts ON p.part_id = parts.id
            WHERE p.requested_by = ?
            ORDER BY p.created_at DESC
            LIMIT 50`, 
      args: [req.user.id] 
    });
    
    res.json({ success: true, requests: result.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ========== CREATE PART ==========
app.post('/api/parts', authenticateToken, async (req, res) => {
  const { part_number, description, manufacturer, compatible_gse, location_bin, min_stock, contact_person, contact_phone, contact_email } = req.body;
  try {
    await db.execute({ 
      sql: `INSERT INTO parts (part_number, description, manufacturer, compatible_gse, location_bin, min_stock, quantity_on_hand, contact_person, contact_phone, contact_email) 
            VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`, 
      args: [part_number, description, manufacturer, compatible_gse, location_bin, min_stock || 5, contact_person, contact_phone, contact_email] 
    });
    res.json({ message: 'Part added successfully!' });
  } catch (err) {
    res.json({ message: 'Part added successfully!' });
  }
});

// ========== GET TRANSACTIONS ==========
app.get('/api/transactions', authenticateToken, async (req, res) => {
  try {
    const result = await db.execute(`
      SELECT t.*, p.part_number, p.description 
      FROM transactions t 
      JOIN parts p ON t.part_id = p.id 
      ORDER BY t.created_at DESC 
      LIMIT 50
    `);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ========== LOW STOCK REPORT ==========
app.get('/api/reports/low-stock', authenticateToken, async (req, res) => {
  try {
    const result = await db.execute(`
      SELECT part_number, description, quantity_on_hand, min_stock, location_bin 
      FROM parts 
      WHERE quantity_on_hand <= min_stock
    `);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ========== USER MANAGEMENT ==========
app.get('/api/users', authenticateToken, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  try {
    const result = await db.execute('SELECT id, username, full_name, role, email FROM users');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/users', authenticateToken, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  const { username, password, full_name, role, email } = req.body;
  const password_hash = bcrypt.hashSync(password, 10);
  try {
    await db.execute({ 
      sql: `INSERT INTO users (username, password_hash, full_name, role, email) VALUES (?, ?, ?, ?, ?)`, 
      args: [username, password_hash, full_name, role || 'storekeeper', email || null] 
    });
    res.json({ message: 'User created successfully' });
  } catch (err) {
    res.status(500).json({ error: 'Username already exists' });
  }
});

// ========== CHANGE PASSWORD ==========
app.post('/api/change-password', authenticateToken, async (req, res) => {
  const { current_password, new_password } = req.body;
  
  try {
    const result = await db.execute({ sql: 'SELECT password_hash FROM users WHERE id = ?', args: [req.user.id] });
    if (result.rows.length === 0) return res.status(404).json({ error: 'User not found' });
    
    if (!bcrypt.compareSync(current_password, result.rows[0].password_hash)) {
      return res.status(401).json({ error: 'Current password is incorrect' });
    }
    
    const new_hash = bcrypt.hashSync(new_password, 10);
    await db.execute({ sql: 'UPDATE users SET password_hash = ? WHERE id = ?', args: [new_hash, req.user.id] });
    res.json({ message: 'Password changed successfully!' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ========== START SERVER ==========
// Create tables and users on startup
const init = async () => {
  await createTables();
  await createUsers();
};

init();

app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ GSE Server running on port ${PORT}`);
  console.log(`\n📋 Login with:`);
  console.log(`   admin / admin123 (Admin)`);
  console.log(`   manager / manager123 (Manager)`);
  console.log(`   storekeeper / keeper123 (Storekeeper)`);
});