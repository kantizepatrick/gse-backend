const express = require('express');
const { createClient } = require('@libsql/client');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const nodemailer = require('nodemailer');
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

// ========== CREATE TABLES (DROP AND RECREATE FOR CLEAN SLATE) ==========
const createTables = async () => {
  try {
    // Drop existing tables to ensure clean slate
    console.log('🔧 Recreating tables for clean slate...');
    await db.execute(`DROP TABLE IF EXISTS pending_issues`);
    await db.execute(`DROP TABLE IF EXISTS transactions`);
    await db.execute(`DROP TABLE IF EXISTS parts`);
    await db.execute(`DROP TABLE IF EXISTS users`);
    
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
    
    console.log('✅ Tables recreated successfully');
  } catch (err) {
    console.error('Table error:', err.message);
  }
};
createTables();

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

// ========== INITIALIZE USERS AND PARTS ==========
app.post('/api/init-users', async (req, res) => {
  try {
    console.log('🔧 Initializing default users and parts...');
    
    // Create default users
    const defaultUsers = [
      ['admin', bcrypt.hashSync('admin123', 10), 'System Admin', 'admin', 'admin@example.com'],
      ['manager', bcrypt.hashSync('manager123', 10), 'GSE Manager', 'manager', 'manager@example.com'],
      ['storekeeper', bcrypt.hashSync('keeper123', 10), 'Store Keeper', 'storekeeper', 'storekeeper@example.com']
    ];
    
    for (const user of defaultUsers) {
      try {
        const check = await db.execute({ sql: 'SELECT id FROM users WHERE username = ?', args: [user[0]] });
        if (check.rows.length === 0) {
          await db.execute({ sql: `INSERT INTO users (username, password_hash, full_name, role, email) VALUES (?, ?, ?, ?, ?)`, args: user });
          console.log(`✅ Created user: ${user[0]}`);
        }
      } catch (err) {
        console.log(`Error with user ${user[0]}:`, err.message);
      }
    }
    
    // Create sample parts
    const sampleParts = [
      ['P001', 'Brake Pad', 'Bendix', 'Tow Tractor', 'A-01', 10, 5, 'John Smith', '+1 234 567 8900', 'john@bendix.com'],
      ['P002', 'Oil Filter', 'Fram', 'GPU', 'B-02', 15, 5, 'Jane Doe', '+1 234 567 8901', 'jane@fram.com'],
      ['P003', 'Air Filter', 'Donaldson', 'Tow Tractor', 'C-03', 8, 5, 'Bob Wilson', '+1 234 567 8902', 'bob@donaldson.com'],
    ];
    
    for (const part of sampleParts) {
      try {
        const check = await db.execute({ sql: 'SELECT id FROM parts WHERE part_number = ?', args: [part[0]] });
        if (check.rows.length === 0) {
          await db.execute({ 
            sql: `INSERT INTO parts (part_number, description, manufacturer, compatible_gse, location_bin, quantity_on_hand, min_stock, contact_person, contact_phone, contact_email) 
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, 
            args: part 
          });
          console.log(`✅ Created part: ${part[0]}`);
        }
      } catch (err) {
        console.log(`Error with part ${part[0]}:`, err.message);
      }
    }
    
    const users = await db.execute('SELECT id, username, role FROM users');
    const parts = await db.execute('SELECT id, part_number FROM parts');
    
    res.json({ 
      success: true, 
      message: 'Users and parts initialized',
      users: users.rows,
      parts: parts.rows,
      credentials: {
        admin: { username: 'admin', password: 'admin123', role: 'admin' },
        manager: { username: 'manager', password: 'manager123', role: 'manager' },
        storekeeper: { username: 'storekeeper', password: 'keeper123', role: 'storekeeper' }
      }
    });
    
  } catch (err) {
    console.error('Init error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ========== LOGIN ==========
app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  console.log(`Login attempt: ${username}`);
  
  try {
    const result = await db.execute({ sql: 'SELECT * FROM users WHERE username = ?', args: [username] });
    
    if (result.rows.length === 0) {
      console.log(`User not found: ${username}`);
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    
    const user = result.rows[0];
    
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

// ========== STOREKEEPER: SUBMIT ISSUE REQUEST ==========
app.post('/api/requests/issue', authenticateToken, async (req, res) => {
  const { part_number, quantity, gse_registration, technician_name, work_order, notes } = req.body;
  
  console.log(`📋 New request from ${req.user.username}: ${part_number}, Qty: ${quantity}`);
  
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
    
    console.log(`✅ Request submitted successfully`);
    res.json({ success: true, message: 'Issue request submitted for approval' });
    
  } catch (err) {
    console.error(`❌ Error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// ========== MANAGER/ADMIN: GET PENDING REQUESTS ==========
app.get('/api/requests/pending', authenticateToken, async (req, res) => {
  console.log(`🔐 Pending requests requested by: ${req.user.username}, role: ${req.user.role}`);
  
  if (req.user.role !== 'admin' && req.user.role !== 'manager') {
    return res.status(403).json({ error: 'Access denied. Managers and Admins only.' });
  }
  
  try {
    const result = await db.execute(`
      SELECT 
        p.id,
        p.part_number,
        p.quantity,
        p.gse_registration,
        p.technician_name,
        p.work_order,
        p.notes,
        p.requested_by_name,
        p.status,
        p.created_at,
        parts.quantity_on_hand as current_stock,
        parts.description
      FROM pending_issues p
      JOIN parts ON p.part_id = parts.id
      WHERE p.status = 'pending'
      ORDER BY p.created_at DESC
    `);
    
    console.log(`📋 Found ${result.rows.length} pending requests`);
    res.json({ success: true, requests: result.rows });
    
  } catch (err) {
    console.error(`❌ Error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// ========== MANAGER/ADMIN: APPROVE REQUEST ==========
app.post('/api/requests/:id/approve', authenticateToken, async (req, res) => {
  const { id } = req.params;
  const { comment } = req.body;
  
  console.log(`✅ Approving request ${id} by ${req.user.username}`);
  
  if (req.user.role !== 'admin' && req.user.role !== 'manager') {
    return res.status(403).json({ error: 'Access denied. Managers and Admins only.' });
  }
  
  try {
    const requestResult = await db.execute({ sql: 'SELECT * FROM pending_issues WHERE id = ? AND status = "pending"', args: [id] });
    
    if (requestResult.rows.length === 0) {
      return res.status(404).json({ error: 'Request not found or already processed' });
    }
    
    const request = requestResult.rows[0];
    
    const partResult = await db.execute({ sql: 'SELECT quantity_on_hand FROM parts WHERE id = ?', args: [request.part_id] });
    const currentStock = partResult.rows[0].quantity_on_hand;
    const requestQuantity = parseInt(request.quantity);
    
    if (currentStock < requestQuantity) {
      return res.status(400).json({ error: `Insufficient stock! Only ${currentStock} units available.` });
    }
    
    const newStock = currentStock - requestQuantity;
    
    // Insert transaction
    await db.execute({ 
      sql: `INSERT INTO transactions 
            (part_id, transaction_type, quantity, gse_registration, technician_name, work_order, notes, created_by, created_at) 
            VALUES (?, 'ISSUE', ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`, 
      args: [request.part_id, requestQuantity, request.gse_registration, request.technician_name, request.work_order, request.notes, req.user.username] 
    });
    
    // Update stock
    await db.execute({ sql: 'UPDATE parts SET quantity_on_hand = ? WHERE id = ?', args: [newStock, request.part_id] });
    
    // Update request status
    await db.execute({ 
      sql: `UPDATE pending_issues SET status = 'approved', admin_comment = ?, approved_by = ?, approved_at = CURRENT_TIMESTAMP WHERE id = ?`, 
      args: [comment || null, req.user.username, id] 
    });
    
    console.log(`✅ Request ${id} APPROVED`);
    res.json({ success: true, message: 'Request approved and stock deducted' });
    
  } catch (err) {
    console.error(`❌ Error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// ========== MANAGER/ADMIN: REJECT REQUEST ==========
app.post('/api/requests/:id/reject', authenticateToken, async (req, res) => {
  const { id } = req.params;
  const { comment } = req.body;
  
  console.log(`❌ Rejecting request ${id} by ${req.user.username}`);
  
  if (req.user.role !== 'admin' && req.user.role !== 'manager') {
    return res.status(403).json({ error: 'Access denied. Managers and Admins only.' });
  }
  
  try {
    const requestResult = await db.execute({ sql: 'SELECT * FROM pending_issues WHERE id = ? AND status = "pending"', args: [id] });
    
    if (requestResult.rows.length === 0) {
      return res.status(404).json({ error: 'Request not found or already processed' });
    }
    
    await db.execute({ 
      sql: `UPDATE pending_issues SET status = 'rejected', admin_comment = ?, approved_by = ?, approved_at = CURRENT_TIMESTAMP WHERE id = ?`, 
      args: [comment || null, req.user.username, id] 
    });
    
    console.log(`❌ Request ${id} REJECTED`);
    res.json({ success: true, message: 'Request rejected' });
    
  } catch (err) {
    console.error(`❌ Error: ${err.message}`);
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

// ========== DEBUG ENDPOINTS ==========
app.get('/api/debug/users', async (req, res) => {
  try {
    const result = await db.execute('SELECT id, username, role FROM users');
    res.json({ success: true, users: result.rows });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

app.get('/api/debug/pending', async (req, res) => {
  try {
    const result = await db.execute('SELECT * FROM pending_issues');
    res.json({ pending_issues: result.rows });
  } catch (err) {
    res.json({ error: err.message });
  }
});

// ========== START SERVER ==========
app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ GSE Server running on port ${PORT}`);
  console.log(`✅ Approval endpoints: /api/requests/:id/approve and /api/requests/:id/reject`);
  console.log(`\n📋 Default Logins:`);
  console.log(`   admin / admin123 (Admin)`);
  console.log(`   manager / manager123 (Manager)`);
  console.log(`   storekeeper / keeper123 (Storekeeper)`);
});