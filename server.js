const express = require('express');
const { createClient } = require('@libsql/client');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const cors = require('cors');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 5000;
const SECRET_KEY = 'gse_inventory_secret_key_2024';

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
      maintenance_type TEXT DEFAULT 'hour',
      service_interval_hours INTEGER DEFAULT 250,
      service_interval_months INTEGER DEFAULT 6,
      service_interval_years INTEGER DEFAULT 1,
      last_service_hours INTEGER DEFAULT 0,
      last_service_date TEXT,
      last_service_year INTEGER,
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
    
    // Drop and recreate gse_maintenance table to ensure correct schema
    await db.execute(`DROP TABLE IF EXISTS gse_maintenance`);
    await db.execute(`CREATE TABLE gse_maintenance (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      equipment_name TEXT NOT NULL,
      equipment_type TEXT,
      maintenance_type TEXT DEFAULT 'hour',
      part_id INTEGER,
      current_hours INTEGER DEFAULT 0,
      last_service_hours INTEGER DEFAULT 0,
      service_interval_hours INTEGER DEFAULT 250,
      next_service_hours INTEGER DEFAULT 0,
      hours_remaining INTEGER DEFAULT 0,
      last_service_date TEXT,
      service_interval_months INTEGER DEFAULT 6,
      next_service_date TEXT,
      days_remaining INTEGER DEFAULT 0,
      last_service_year INTEGER,
      service_interval_years INTEGER DEFAULT 1,
      next_service_year INTEGER,
      years_remaining INTEGER DEFAULT 0,
      status TEXT DEFAULT 'upcoming',
      service_performed TEXT,
      technician_name TEXT,
      notes TEXT,
      date_performed DATETIME DEFAULT CURRENT_TIMESTAMP,
      created_by TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    
    console.log('✅ Tables ready');
  } catch (err) {
    console.error('Table error:', err.message);
  }
};

// ========== UPDATE MAINTENANCE STATUS HELPER ==========
const updateMaintenanceStatus = async (partId) => {
  try {
    const partResult = await db.execute({ sql: 'SELECT * FROM parts WHERE id = ?', args: [partId] });
    if (partResult.rows.length === 0) return;
    
    const part = partResult.rows[0];
    const maintType = part.maintenance_type;
    
    if (maintType === 'none') return;
    
    const maintResult = await db.execute({ sql: 'SELECT * FROM gse_maintenance WHERE part_id = ?', args: [partId] });
    
    if (maintResult.rows.length === 0) {
      // Create maintenance record
      let status = 'upcoming';
      if (maintType === 'hour') {
        const currentHours = part.last_service_hours || 0;
        const interval = part.service_interval_hours || 250;
        const nextDue = currentHours + interval;
        const remaining = nextDue - currentHours;
        if (remaining <= 0) status = 'overdue';
        else if (remaining <= 50) status = 'due_soon';
        
        await db.execute({
          sql: `INSERT INTO gse_maintenance 
                (equipment_name, equipment_type, maintenance_type, part_id,
                 current_hours, last_service_hours, service_interval_hours, next_service_hours, hours_remaining, status, created_by) 
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'system')`,
          args: [part.part_number, part.description || 'Part', maintType, partId,
                 currentHours, currentHours, interval, nextDue, remaining, status]
        });
      } else if (maintType === 'month') {
        const lastDate = part.last_service_date ? new Date(part.last_service_date) : new Date();
        const interval = part.service_interval_months || 6;
        const nextDate = new Date(lastDate);
        nextDate.setMonth(nextDate.getMonth() + interval);
        const today = new Date();
        const remaining = Math.ceil((nextDate - today) / (1000 * 60 * 60 * 24));
        if (remaining <= 0) status = 'overdue';
        else if (remaining <= 14) status = 'due_soon';
        
        await db.execute({
          sql: `INSERT INTO gse_maintenance 
                (equipment_name, equipment_type, maintenance_type, part_id,
                 last_service_date, service_interval_months, next_service_date, days_remaining, status, created_by) 
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'system')`,
          args: [part.part_number, part.description || 'Part', maintType, partId,
                 part.last_service_date, interval, nextDate.toISOString().split('T')[0], remaining, status]
        });
      } else if (maintType === 'year') {
        const lastYear = part.last_service_year || new Date().getFullYear();
        const interval = part.service_interval_years || 1;
        const nextYear = lastYear + interval;
        const currentYear = new Date().getFullYear();
        const remaining = nextYear - currentYear;
        if (remaining < 0) status = 'overdue';
        else if (remaining === 0) status = 'due_soon';
        
        await db.execute({
          sql: `INSERT INTO gse_maintenance 
                (equipment_name, equipment_type, maintenance_type, part_id,
                 last_service_year, service_interval_years, next_service_year, years_remaining, status, created_by) 
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'system')`,
          args: [part.part_number, part.description || 'Part', maintType, partId,
                 lastYear, interval, nextYear, remaining, status]
        });
      }
      console.log(`✅ Created maintenance record for ${part.part_number} with status: ${status}`);
      return;
    }
    
    const maint = maintResult.rows[0];
    let newStatus = 'upcoming';
    
    if (maintType === 'hour') {
      const currentValue = maint.current_hours || 0;
      const lastService = maint.last_service_hours || 0;
      const interval = part.service_interval_hours || 250;
      const nextDue = lastService + interval;
      const remainingValue = nextDue - currentValue;
      
      if (remainingValue <= 0) {
        newStatus = 'overdue';
      } else if (remainingValue <= 50) {
        newStatus = 'due_soon';
      } else {
        newStatus = 'upcoming';
      }
      
      await db.execute({
        sql: `UPDATE gse_maintenance 
              SET next_service_hours = ?, hours_remaining = ?, status = ?, updated_at = CURRENT_TIMESTAMP 
              WHERE part_id = ?`,
        args: [nextDue, remainingValue, newStatus, partId]
      });
    } else if (maintType === 'month') {
      const lastDate = maint.last_service_date ? new Date(maint.last_service_date) : new Date();
      const interval = part.service_interval_months || 6;
      const nextDate = new Date(lastDate);
      nextDate.setMonth(nextDate.getMonth() + interval);
      const today = new Date();
      const remainingValue = Math.ceil((nextDate - today) / (1000 * 60 * 60 * 24));
      
      if (remainingValue <= 0) {
        newStatus = 'overdue';
      } else if (remainingValue <= 14) {
        newStatus = 'due_soon';
      } else {
        newStatus = 'upcoming';
      }
      
      await db.execute({
        sql: `UPDATE gse_maintenance 
              SET next_service_date = ?, days_remaining = ?, status = ?, updated_at = CURRENT_TIMESTAMP 
              WHERE part_id = ?`,
        args: [nextDate.toISOString().split('T')[0], remainingValue, newStatus, partId]
      });
    } else if (maintType === 'year') {
      const lastYear = maint.last_service_year || new Date().getFullYear();
      const interval = part.service_interval_years || 1;
      const nextYear = lastYear + interval;
      const currentYear = new Date().getFullYear();
      const remainingValue = nextYear - currentYear;
      
      if (remainingValue < 0) {
        newStatus = 'overdue';
      } else if (remainingValue === 0) {
        newStatus = 'due_soon';
      } else {
        newStatus = 'upcoming';
      }
      
      await db.execute({
        sql: `UPDATE gse_maintenance 
              SET next_service_year = ?, years_remaining = ?, status = ?, updated_at = CURRENT_TIMESTAMP 
              WHERE part_id = ?`,
        args: [nextYear, remainingValue, newStatus, partId]
      });
    }
    
    console.log(`✅ Status updated for ${part.part_number}: ${newStatus}`);
  } catch (err) {
    console.error('Error updating maintenance status:', err.message);
  }
};

// ========== CREATE SAMPLE DATA ==========
const createSampleData = async () => {
  // Sample parts with different maintenance types
  const sampleParts = [
    ['P001', 'Brake Pad', 'Bendix', 'Tow Tractor', 'A-01', 50, 10, 'hour', 250, null, null, 1250, null, null, 'John Smith', '+1 234 567 8900', 'john@bendix.com'],
    ['P002', 'Oil Filter', 'Fram', 'GPU', 'B-02', 30, 8, 'hour', 200, null, null, 800, null, null, 'Jane Doe', '+1 234 567 8901', 'jane@fram.com'],
    ['P003', 'Air Filter', 'Donaldson', 'Tow Tractor', 'C-03', 25, 5, 'hour', 300, null, null, 200, null, null, 'Bob Wilson', '+1 234 567 8902', 'bob@donaldson.com'],
    ['P004', 'Hydraulic Fluid', 'Shell', 'All GSE', 'D-01', 100, 20, 'month', null, 6, null, null, '2025-01-15', null, 'Shell Support', '+1 234 567 8903', 'support@shell.com'],
    ['P005', 'Battery', 'Exide', 'GPU', 'E-01', 15, 5, 'month', null, 3, null, null, '2025-05-15', null, 'Exide Tech', '+1 234 567 8904', 'tech@exide.com'],
    ['P006', 'Fire Extinguisher', 'Amerex', 'Safety Equipment', 'F-01', 8, 2, 'year', null, null, 1, null, null, 2023, 'Amerex Safety', '+1 234 567 8905', 'safety@amerex.com'],
    ['P007', 'Annual Lift Inspection', 'Interface', 'Lifting Equipment', 'G-01', 5, 1, 'year', null, null, 1, null, null, 2024, 'Interface Tech', '+1 234 567 8906', 'tech@interface.com'],
    ['P008', 'Hand Tools Set', 'Stanley', 'Hand Tools', 'H-01', 20, 5, 'none', null, null, null, null, null, null, 'Stanley Tools', '+1 234 567 8907', 'tools@stanley.com']
  ];
  
  for (const part of sampleParts) {
    try {
      const existing = await db.execute({ sql: 'SELECT id FROM parts WHERE part_number = ?', args: [part[0]] });
      if (existing.rows.length === 0) {
        const result = await db.execute({ 
          sql: `INSERT INTO parts (part_number, description, manufacturer, compatible_gse, location_bin, quantity_on_hand, min_stock,
                maintenance_type, service_interval_hours, service_interval_months, service_interval_years,
                last_service_hours, last_service_date, last_service_year,
                contact_person, contact_phone, contact_email) 
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          args: part
        });
        console.log(`✅ Created sample part: ${part[0]}`);
        
        // Create maintenance record
        await updateMaintenanceStatus(result.lastInsertRowid);
      }
    } catch (err) {
      console.log(`⚠️ Error with part ${part[0]}:`, err.message);
    }
  }
};

// ========== CREATE DEFAULT USERS ==========
const createUsers = async () => {
  const users = [
    { username: 'admin', password: 'admin123', full_name: 'System Admin', role: 'admin', email: 'admin@example.com' },
    { username: 'manager', password: 'manager123', full_name: 'GSE Manager', role: 'manager', email: 'manager@example.com' },
    { username: 'storekeeper', password: 'keeper123', full_name: 'Store Keeper', role: 'storekeeper', email: 'storekeeper@example.com' }
  ];
  
  for (const user of users) {
    const existing = await db.execute({ sql: 'SELECT id FROM users WHERE username = ?', args: [user.username] });
    if (existing.rows.length === 0) {
      const hashedPassword = bcrypt.hashSync(user.password, 10);
      await db.execute({ 
        sql: 'INSERT INTO users (username, password_hash, full_name, role, email) VALUES (?, ?, ?, ?, ?)', 
        args: [user.username, hashedPassword, user.full_name, user.role, user.email] 
      });
      console.log(`✅ Created user: ${user.username}`);
    }
  }
};

// ========== AUTHENTICATION ==========
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

// ========== LOGIN ==========
app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  
  try {
    const result = await db.execute({ sql: 'SELECT * FROM users WHERE username = ?', args: [username] });
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

// ========== GET PARTS ==========
app.get('/api/parts', authenticateToken, async (req, res) => {
  try {
    const result = await db.execute('SELECT * FROM parts ORDER BY part_number');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ========== CREATE PART ==========
app.post('/api/parts', authenticateToken, async (req, res) => {
  const { part_number, description, manufacturer, compatible_gse, location_bin, min_stock,
    maintenance_type, service_interval_hours, service_interval_months, service_interval_years,
    contact_person, contact_phone, contact_email } = req.body;
  
  try {
    const result = await db.execute({ 
      sql: `INSERT INTO parts 
            (part_number, description, manufacturer, compatible_gse, location_bin, min_stock, quantity_on_hand,
             maintenance_type, service_interval_hours, service_interval_months, service_interval_years,
             contact_person, contact_phone, contact_email) 
            VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?)`,
      args: [part_number, description || '', manufacturer || '', compatible_gse || '', location_bin || '', min_stock || 5,
        maintenance_type || 'hour', service_interval_hours || 250, service_interval_months || 6, service_interval_years || 1,
        contact_person || '', contact_phone || '', contact_email || '']
    });
    
    if (maintenance_type !== 'none') {
      await updateMaintenanceStatus(result.lastInsertRowid);
    }
    
    res.json({ message: 'Part added successfully!' });
  } catch (err) {
    console.error('Create part error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ========== DELETE PART ==========
app.delete('/api/parts/:id', authenticateToken, async (req, res) => {
  if (req.user.role !== 'admin' && req.user.role !== 'manager') {
    return res.status(403).json({ error: 'Admin or Manager only' });
  }
  
  try {
    await db.execute({ sql: 'DELETE FROM gse_maintenance WHERE part_id = ?', args: [req.params.id] });
    await db.execute({ sql: 'DELETE FROM parts WHERE id = ?', args: [req.params.id] });
    res.json({ message: 'Part deleted successfully' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ========== RECEIVE PARTS ==========
app.post('/api/transactions/receive', authenticateToken, async (req, res) => {
  const { part_number, quantity, reference_number, notes, current_hours } = req.body;
  
  const receiveQty = parseInt(quantity);
  if (isNaN(receiveQty) || receiveQty <= 0) {
    return res.status(400).json({ error: 'Invalid quantity' });
  }
  
  try {
    const partResult = await db.execute({ sql: 'SELECT id, quantity_on_hand, maintenance_type FROM parts WHERE part_number = ?', args: [part_number] });
    if (partResult.rows.length === 0) {
      return res.status(404).json({ error: 'Part not found' });
    }
    
    const part = partResult.rows[0];
    const newQuantity = part.quantity_on_hand + receiveQty;
    
    await db.execute({ 
      sql: `INSERT INTO transactions (part_id, transaction_type, quantity, reference_number, notes, created_by, created_at) 
            VALUES (?, 'RECEIVE', ?, ?, ?, ?, CURRENT_TIMESTAMP)`, 
      args: [part.id, receiveQty, reference_number || '', notes || '', req.user.username] 
    });
    
    await db.execute({ sql: 'UPDATE parts SET quantity_on_hand = ? WHERE id = ?', args: [newQuantity, part.id] });
    
    if (current_hours && part.maintenance_type === 'hour') {
      await db.execute({ sql: 'UPDATE gse_maintenance SET current_hours = ? WHERE part_id = ?', args: [current_hours, part.id] });
    }
    
    await updateMaintenanceStatus(part.id);
    
    res.json({ success: true, message: 'Parts received successfully' });
  } catch (err) {
    console.error('Receive error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ========== SUBMIT ISSUE REQUEST ==========
app.post('/api/requests/issue', authenticateToken, async (req, res) => {
  const { part_number, quantity, gse_registration, technician_name, work_order, notes } = req.body;
  
  const requestQty = parseInt(quantity);
  if (isNaN(requestQty) || requestQty <= 0) {
    return res.status(400).json({ error: 'Invalid quantity' });
  }
  
  try {
    const partResult = await db.execute({ sql: 'SELECT id, quantity_on_hand FROM parts WHERE part_number = ?', args: [part_number] });
    if (partResult.rows.length === 0) {
      return res.status(404).json({ error: 'Part not found' });
    }
    
    const part = partResult.rows[0];
    if (part.quantity_on_hand < requestQty) {
      return res.status(400).json({ error: 'Insufficient stock available' });
    }
    
    await db.execute({ 
      sql: `INSERT INTO pending_issues 
            (part_number, part_id, quantity, gse_registration, technician_name, work_order, notes, requested_by, requested_by_name, status, created_at) 
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', CURRENT_TIMESTAMP)`, 
      args: [part_number, part.id, requestQty, gse_registration || '', technician_name || '', work_order || '', notes || '', req.user.id, req.user.username] 
    });
    
    res.json({ success: true, message: 'Issue request submitted for approval' });
  } catch (err) {
    console.error('Submit error:', err.message);
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
    const requestResult = await db.execute({ 
      sql: "SELECT * FROM pending_issues WHERE id = ? AND status = 'pending'", 
      args: [id] 
    });
    
    if (requestResult.rows.length === 0) {
      return res.status(404).json({ error: 'Request not found' });
    }
    
    const request = requestResult.rows[0];
    const requestQty = parseInt(request.quantity);
    
    const partResult = await db.execute({ 
      sql: 'SELECT quantity_on_hand FROM parts WHERE id = ?', 
      args: [request.part_id] 
    });
    
    const currentStock = partResult.rows[0].quantity_on_hand;
    const newStock = currentStock - requestQty;
    
    if (currentStock < requestQty) {
      return res.status(400).json({ error: `Insufficient stock! Only ${currentStock} units available.` });
    }
    
    await db.execute({ 
      sql: `INSERT INTO transactions 
            (part_id, transaction_type, quantity, gse_registration, technician_name, work_order, notes, created_by, created_at) 
            VALUES (?, 'ISSUE', ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`, 
      args: [request.part_id, requestQty, request.gse_registration || '', request.technician_name || '', request.work_order || '', request.notes || '', req.user.username] 
    });
    
    await db.execute({ 
      sql: 'UPDATE parts SET quantity_on_hand = ? WHERE id = ?', 
      args: [newStock, request.part_id] 
    });
    
    await db.execute({ 
      sql: "UPDATE pending_issues SET status = 'approved', admin_comment = ?, approved_by = ?, approved_at = CURRENT_TIMESTAMP WHERE id = ?", 
      args: [comment || null, req.user.username, id] 
    });
    
    res.json({ success: true, message: 'Request approved and stock deducted' });
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
      sql: "UPDATE pending_issues SET status = 'rejected', admin_comment = ?, approved_by = ?, approved_at = CURRENT_TIMESTAMP WHERE id = ?", 
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

// ========== GET GSE MAINTENANCE - SIMPLIFIED AND FIXED ==========
app.get('/api/gse-maintenance', authenticateToken, async (req, res) => {
  try {
    console.log(`🔧 Maintenance data requested by: ${req.user.username}`);
    
    const result = await db.execute(`
      SELECT 
        id,
        equipment_name,
        equipment_type,
        maintenance_type,
        part_id,
        COALESCE(current_hours, 0) as current_hours,
        COALESCE(last_service_hours, 0) as last_service_hours,
        COALESCE(service_interval_hours, 250) as service_interval_hours,
        COALESCE(next_service_hours, 0) as next_service_hours,
        COALESCE(hours_remaining, 0) as hours_remaining,
        last_service_date,
        COALESCE(service_interval_months, 6) as service_interval_months,
        next_service_date,
        COALESCE(days_remaining, 0) as days_remaining,
        last_service_year,
        COALESCE(service_interval_years, 1) as service_interval_years,
        next_service_year,
        COALESCE(years_remaining, 0) as years_remaining,
        COALESCE(status, 'upcoming') as status,
        service_performed,
        technician_name,
        notes,
        date_performed
      FROM gse_maintenance 
      ORDER BY 
        CASE status
          WHEN 'overdue' THEN 1
          WHEN 'due_soon' THEN 2
          ELSE 3
        END,
        equipment_name ASC
    `);
    
    console.log(`✅ Retrieved ${result.rows.length} maintenance items`);
    res.json({ success: true, equipment: result.rows });
    
  } catch (err) {
    console.error('❌ Error fetching maintenance:', err.message);
    res.json({ success: true, equipment: [] });
  }
});

// ========== RECORD SERVICE ==========
app.post('/api/gse-maintenance/:id/service', authenticateToken, async (req, res) => {
  const { id } = req.params;
  const { service_performed, technician_name, notes, current_value } = req.body;
  
  try {
    const maintResult = await db.execute({ sql: 'SELECT * FROM gse_maintenance WHERE id = ?', args: [id] });
    if (maintResult.rows.length === 0) {
      return res.status(404).json({ error: 'Item not found' });
    }
    
    const maint = maintResult.rows[0];
    const newValue = current_value || 0;
    
    await db.execute({
      sql: `UPDATE gse_maintenance 
            SET current_hours = ?,
                last_service_hours = ?,
                service_performed = ?,
                technician_name = ?,
                notes = ?,
                date_performed = CURRENT_TIMESTAMP,
                updated_at = CURRENT_TIMESTAMP
            WHERE id = ?`,
      args: [newValue, newValue, service_performed, technician_name, notes, id]
    });
    
    if (maint.part_id) {
      await updateMaintenanceStatus(maint.part_id);
    }
    
    res.json({ success: true, message: 'Service recorded successfully!' });
  } catch (err) {
    console.error('Service error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ========== DELETE MAINTENANCE ITEM ==========
app.delete('/api/gse-maintenance/:id', authenticateToken, async (req, res) => {
  if (req.user.role !== 'admin' && req.user.role !== 'manager') {
    return res.status(403).json({ error: 'Admin or Manager only' });
  }
  
  try {
    await db.execute({ sql: 'DELETE FROM gse_maintenance WHERE id = ?', args: [req.params.id] });
    res.json({ message: 'Item removed from maintenance schedule' });
  } catch (err) {
    res.status(500).json({ error: err.message });
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

app.delete('/api/users/:id', authenticateToken, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  if (req.params.id == req.user.id) return res.status(400).json({ error: 'Cannot delete your own account' });
  try {
    await db.execute({ sql: 'DELETE FROM users WHERE id = ?', args: [req.params.id] });
    res.json({ message: 'User deleted successfully' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ========== CHANGE PASSWORD ==========
app.post('/api/change-password', authenticateToken, async (req, res) => {
  const { current_password, new_password } = req.body;
  
  if (!current_password || !new_password) {
    return res.status(400).json({ error: 'Current and new password required' });
  }
  if (new_password.length < 4) {
    return res.status(400).json({ error: 'Password must be at least 4 characters' });
  }
  
  try {
    const result = await db.execute({ sql: 'SELECT password_hash FROM users WHERE id = ?', args: [req.user.id] });
    if (result.rows.length === 0) return res.status(404).json({ error: 'User not found' });
    
    if (!bcrypt.compareSync(current_password, result.rows[0].password_hash)) {
      return res.status(401).json({ error: 'Current password is incorrect' });
    }
    
    const new_hash = bcrypt.hashSync(new_password, 10);
    await db.execute({ sql: 'UPDATE users SET password_hash = ? WHERE id = ?', args: [new_hash, req.user.id] });
    res.json({ message: 'Password changed successfully! Please login again.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ========== ADMIN RESET PASSWORD ==========
app.post('/api/admin/reset-password', authenticateToken, async (req, res) => {
  const { user_id, new_password } = req.body;
  
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Access denied. Admin only.' });
  }
  
  if (!user_id || !new_password || new_password.length < 4) {
    return res.status(400).json({ error: 'User ID and valid password required' });
  }
  
  try {
    const userResult = await db.execute({ sql: 'SELECT id, username FROM users WHERE id = ?', args: [user_id] });
    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    const targetUser = userResult.rows[0];
    const newHashedPassword = bcrypt.hashSync(new_password, 10);
    await db.execute({ sql: 'UPDATE users SET password_hash = ? WHERE id = ?', args: [newHashedPassword, user_id] });
    
    res.json({ success: true, message: `Password reset successfully for ${targetUser.username}` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ========== FORGOT PASSWORD ==========
const resetCodes = new Map();

app.post('/api/forgot-password', async (req, res) => {
  const { username } = req.body;
  
  try {
    const result = await db.execute({ sql: 'SELECT id, username, email FROM users WHERE username = ?', args: [username] });
    if (result.rows.length === 0) {
      return res.json({ success: true, message: 'If an account exists, a reset code has been sent.' });
    }
    
    const resetCode = Math.floor(100000 + Math.random() * 900000).toString();
    resetCodes.set(username, { code: resetCode, expires: Date.now() + 3600000 });
    
    console.log('========================================');
    console.log(`🔐 PASSWORD RESET CODE FOR ${username}: ${resetCode}`);
    console.log('========================================');
    
    res.json({ success: true, message: 'Reset code sent! Check server console.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/reset-password', async (req, res) => {
  const { username, reset_code, new_password } = req.body;
  
  const stored = resetCodes.get(username);
  if (!stored || stored.code !== reset_code) {
    return res.status(400).json({ error: 'Invalid reset code' });
  }
  if (Date.now() > stored.expires) {
    resetCodes.delete(username);
    return res.status(400).json({ error: 'Reset code expired' });
  }
  
  const newHashedPassword = bcrypt.hashSync(new_password, 10);
  await db.execute({ sql: 'UPDATE users SET password_hash = ? WHERE username = ?', args: [newHashedPassword, username] });
  resetCodes.delete(username);
  
  res.json({ success: true, message: 'Password reset successfully!' });
});

// ========== DEBUG ==========
app.get('/api/debug/users', async (req, res) => {
  try {
    const result = await db.execute('SELECT id, username, role FROM users');
    res.json({ users: result.rows });
  } catch (err) {
    res.json({ error: err.message });
  }
});

app.get('/api/debug/maintenance-table', async (req, res) => {
  try {
    const tableCheck = await db.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='gse_maintenance'");
    const count = await db.execute("SELECT COUNT(*) as count FROM gse_maintenance");
    res.json({ 
      table_exists: tableCheck.rows.length > 0,
      row_count: count.rows[0].count
    });
  } catch (err) {
    res.json({ error: err.message });
  }
});

// ========== INITIALIZE ==========
const init = async () => {
  await createTables();
  await createUsers();
  await createSampleData();
  console.log('✅ All data initialized!');
};

init();

// ========== START SERVER ==========
app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ GSE Server running on port ${PORT}`);
  console.log(`\n📋 Login with:`);
  console.log(`   admin / admin123 (Admin)`);
  console.log(`   manager / manager123 (Manager)`);
  console.log(`   storekeeper / keeper123 (Storekeeper)`);
});