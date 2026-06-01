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

// Helper function to convert BigInt to Number for JSON serialization
const convertBigInt = (obj) => {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj === 'bigint') return Number(obj);
  if (Array.isArray(obj)) return obj.map(convertBigInt);
  if (typeof obj === 'object') {
    const newObj = {};
    for (const key in obj) {
      newObj[key] = convertBigInt(obj[key]);
    }
    return newObj;
  }
  return obj;
};

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
    
    await db.execute(`CREATE TABLE IF NOT EXISTS gse_maintenance (
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

// ========== CALCULATE AND UPDATE MAINTENANCE STATUS ==========
const calculateAndUpdateStatus = async (maintenanceId) => {
  try {
    const maintResult = await db.execute({ sql: 'SELECT * FROM gse_maintenance WHERE id = ?', args: [maintenanceId] });
    if (maintResult.rows.length === 0) return;
    
    const maint = maintResult.rows[0];
    const maintType = maint.maintenance_type;
    let newStatus = 'upcoming';
    let remainingValue = 0;
    
    if (maintType === 'hour') {
      const currentHours = Number(maint.current_hours) || 0;
      const lastServiceHours = Number(maint.last_service_hours) || 0;
      const interval = Number(maint.service_interval_hours) || 250;
      const nextDue = lastServiceHours + interval;
      remainingValue = nextDue - currentHours;
      
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
              WHERE id = ?`,
        args: [nextDue, remainingValue, newStatus, maintenanceId]
      });
    } else if (maintType === 'month') {
      const lastDate = maint.last_service_date ? new Date(maint.last_service_date) : new Date();
      const interval = Number(maint.service_interval_months) || 6;
      const nextDate = new Date(lastDate);
      nextDate.setMonth(nextDate.getMonth() + interval);
      const today = new Date();
      remainingValue = Math.ceil((nextDate - today) / (1000 * 60 * 60 * 24));
      
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
              WHERE id = ?`,
        args: [nextDate.toISOString().split('T')[0], remainingValue, newStatus, maintenanceId]
      });
    } else if (maintType === 'year') {
      const lastYear = Number(maint.last_service_year) || new Date().getFullYear();
      const interval = Number(maint.service_interval_years) || 1;
      const nextYear = lastYear + interval;
      const currentYear = new Date().getFullYear();
      remainingValue = nextYear - currentYear;
      
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
              WHERE id = ?`,
        args: [nextYear, remainingValue, newStatus, maintenanceId]
      });
    }
    
    console.log(`✅ Status updated for ${maint.equipment_name}: ${newStatus}`);
    return newStatus;
  } catch (err) {
    console.error('Error calculating status:', err.message);
    return null;
  }
};

// ========== SYNC PART TO MAINTENANCE ==========
const syncPartToMaintenance = async (partId) => {
  try {
    const partResult = await db.execute({ sql: 'SELECT * FROM parts WHERE id = ?', args: [partId] });
    if (partResult.rows.length === 0) return;
    
    const part = partResult.rows[0];
    const maintType = part.maintenance_type;
    
    if (maintType === 'none') return;
    
    const existingMaint = await db.execute({ sql: 'SELECT id FROM gse_maintenance WHERE part_id = ?', args: [partId] });
    
    let status = 'upcoming';
    let currentHours = Number(part.last_service_hours) || 0;
    let intervalHours = Number(part.service_interval_hours) || 250;
    let nextServiceHours = currentHours + intervalHours;
    let hoursRemaining = nextServiceHours - currentHours;
    
    if (maintType === 'hour') {
      if (hoursRemaining <= 0) status = 'overdue';
      else if (hoursRemaining <= 50) status = 'due_soon';
      else status = 'upcoming';
    } else if (maintType === 'month') {
      status = 'upcoming';
    } else if (maintType === 'year') {
      status = 'upcoming';
    }
    
    if (existingMaint.rows.length > 0) {
      await db.execute({
        sql: `UPDATE gse_maintenance 
              SET equipment_name = ?, equipment_type = ?, maintenance_type = ?,
                  current_hours = ?, last_service_hours = ?, service_interval_hours = ?,
                  next_service_hours = ?, hours_remaining = ?, status = ?, updated_at = CURRENT_TIMESTAMP
              WHERE part_id = ?`,
        args: [part.part_number, part.description || 'Part', maintType,
               currentHours, currentHours, intervalHours, nextServiceHours, hoursRemaining, status, partId]
      });
      await calculateAndUpdateStatus(existingMaint.rows[0].id);
    } else {
      const result = await db.execute({
        sql: `INSERT INTO gse_maintenance 
              (equipment_name, equipment_type, maintenance_type, part_id,
               current_hours, last_service_hours, service_interval_hours, next_service_hours, hours_remaining,
               status, created_by, created_at, updated_at) 
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'system', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
        args: [part.part_number, part.description || 'Part', maintType, partId,
               currentHours, currentHours, intervalHours, nextServiceHours, hoursRemaining, status]
      });
      await calculateAndUpdateStatus(Number(result.lastInsertRowid));
    }
    console.log(`✅ Part ${part.part_number} synced to maintenance with status: ${status}`);
  } catch (err) {
    console.error('Error syncing part to maintenance:', err.message);
  }
};

// ========== CREATE SAMPLE DATA ==========
const createSampleData = async () => {
  const sampleParts = [
    ['P001', 'Brake Pad', 'Bendix', 'Tow Tractor', 'A-01', 50, 10, 'hour', 250, null, null, 1250, null, null, 'John Smith', '+1 234 567 8900', 'john@bendix.com'],
    ['P002', 'Oil Filter', 'Fram', 'GPU', 'B-02', 30, 8, 'hour', 200, null, null, 950, null, null, 'Jane Doe', '+1 234 567 8901', 'jane@fram.com'],
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
        await syncPartToMaintenance(Number(result.lastInsertRowid));
      }
    } catch (err) {
      console.log(`⚠️ Error with part ${part[0]}:`, err.message);
    }
  }
  
  const standaloneEquipment = [
    ['Tow Tractor #5', 'Tow Tractor', 'hour', 250, 1250, 'overdue'],
    ['GPU Unit #2', 'GPU', 'hour', 200, 950, 'due_soon'],
    ['Battery Charger #3', 'Battery Charger', 'month', 6, null, 'upcoming']
  ];
  
  for (const eq of standaloneEquipment) {
    const existing = await db.execute({ sql: 'SELECT id FROM gse_maintenance WHERE equipment_name = ?', args: [eq[0]] });
    if (existing.rows.length === 0) {
      await db.execute({
        sql: `INSERT INTO gse_maintenance 
              (equipment_name, equipment_type, maintenance_type, service_interval_hours, service_interval_months, 
               current_hours, last_service_hours, status, created_by, created_at, updated_at) 
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'system', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
        args: [eq[0], eq[1], eq[2], eq[2] === 'hour' ? eq[3] : null, eq[2] === 'month' ? eq[3] : null, eq[4], eq[4], eq[5]]
      });
      console.log(`✅ Created standalone equipment: ${eq[0]}`);
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
      const token = jwt.sign({ id: Number(user.id), username: user.username, role: user.role }, SECRET_KEY);
      const responseUser = {
        id: Number(user.id),
        username: user.username,
        full_name: user.full_name,
        role: user.role,
        email: user.email
      };
      res.json({ token, user: responseUser });
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
    const convertedData = convertBigInt(result.rows);
    res.json(convertedData);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ========== CREATE PART ==========
app.post('/api/parts', authenticateToken, async (req, res) => {
  const { part_number, description, manufacturer, compatible_gse, location_bin, min_stock,
    maintenance_type, service_interval_hours, service_interval_months, service_interval_years,
    last_service_hours, last_service_date, last_service_year,
    contact_person, contact_phone, contact_email } = req.body;
  
  try {
    const result = await db.execute({ 
      sql: `INSERT INTO parts 
            (part_number, description, manufacturer, compatible_gse, location_bin, min_stock, quantity_on_hand,
             maintenance_type, service_interval_hours, service_interval_months, service_interval_years,
             last_service_hours, last_service_date, last_service_year,
             contact_person, contact_phone, contact_email) 
            VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [part_number, description || '', manufacturer || '', compatible_gse || '', location_bin || '', min_stock || 5,
        maintenance_type || 'hour', service_interval_hours || 250, service_interval_months || 6, service_interval_years || 1,
        last_service_hours || 0, last_service_date || null, last_service_year || null,
        contact_person || '', contact_phone || '', contact_email || '']
    });
    
    console.log(`✅ Part created: ${part_number}`);
    await syncPartToMaintenance(Number(result.lastInsertRowid));
    
    res.json({ message: 'Part added successfully and synced to maintenance schedule!' });
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
    res.json({ message: 'Part deleted successfully from Parts and Maintenance' });
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
    const newQuantity = Number(part.quantity_on_hand) + receiveQty;
    
    await db.execute({ 
      sql: `INSERT INTO transactions (part_id, transaction_type, quantity, reference_number, notes, created_by, created_at) 
            VALUES (?, 'RECEIVE', ?, ?, ?, ?, CURRENT_TIMESTAMP)`, 
      args: [part.id, receiveQty, reference_number || '', notes || '', req.user.username] 
    });
    
    await db.execute({ sql: 'UPDATE parts SET quantity_on_hand = ? WHERE id = ?', args: [newQuantity, part.id] });
    
    if (current_hours && part.maintenance_type === 'hour') {
      await db.execute({ sql: 'UPDATE gse_maintenance SET current_hours = ? WHERE part_id = ?', args: [current_hours, part.id] });
      const maintResult = await db.execute({ sql: 'SELECT id FROM gse_maintenance WHERE part_id = ?', args: [part.id] });
      if (maintResult.rows.length > 0) {
        await calculateAndUpdateStatus(Number(maintResult.rows[0].id));
      }
    }
    
    res.json({ success: true, message: 'Parts received successfully' });
  } catch (err) {
    console.error('Receive error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ========== GSE MAINTENANCE API ==========

// Get all maintenance items
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
    
    const convertedData = convertBigInt(result.rows);
    console.log(`✅ Retrieved ${convertedData.length} maintenance items`);
    res.json({ success: true, equipment: convertedData });
  } catch (err) {
    console.error('❌ Error fetching maintenance:', err.message);
    res.json({ success: true, equipment: [] });
  }
});

// Add new equipment to maintenance
app.post('/api/gse-maintenance', authenticateToken, async (req, res) => {
  const { equipment_name, equipment_type, maintenance_type, interval_value, current_value, notes } = req.body;
  
  try {
    let status = 'upcoming';
    let currentValue = current_value || 0;
    let interval = interval_value || 250;
    
    if (maintenance_type === 'hour') {
      if (currentValue <= 0) status = 'overdue';
      else if (currentValue <= 50) status = 'due_soon';
    }
    
    const result = await db.execute({
      sql: `INSERT INTO gse_maintenance 
            (equipment_name, equipment_type, maintenance_type,
             current_hours, last_service_hours, service_interval_hours,
             status, notes, created_by, created_at, updated_at) 
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      args: [equipment_name, equipment_type || '', maintenance_type, currentValue, currentValue, interval, status, notes || '', req.user.username]
    });
    
    await calculateAndUpdateStatus(Number(result.lastInsertRowid));
    
    res.json({ success: true, message: 'Equipment added to maintenance schedule', id: Number(result.lastInsertRowid) });
  } catch (err) {
    console.error('Add equipment error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Record service on maintenance item
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
    const today = new Date().toISOString().split('T')[0];
    const currentYear = new Date().getFullYear();
    
    if (maint.maintenance_type === 'hour') {
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
    } else if (maint.maintenance_type === 'month') {
      await db.execute({
        sql: `UPDATE gse_maintenance 
              SET last_service_date = ?,
                  service_performed = ?,
                  technician_name = ?,
                  notes = ?,
                  date_performed = CURRENT_TIMESTAMP,
                  updated_at = CURRENT_TIMESTAMP
              WHERE id = ?`,
        args: [today, service_performed, technician_name, notes, id]
      });
    } else if (maint.maintenance_type === 'year') {
      await db.execute({
        sql: `UPDATE gse_maintenance 
              SET last_service_year = ?,
                  service_performed = ?,
                  technician_name = ?,
                  notes = ?,
                  date_performed = CURRENT_TIMESTAMP,
                  updated_at = CURRENT_TIMESTAMP
              WHERE id = ?`,
        args: [currentYear, service_performed, technician_name, notes, id]
      });
    }
    
    // Recalculate status after service
    await calculateAndUpdateStatus(Number(id));
    
    // If linked to a part, also update the part
    if (maint.part_id) {
      await syncPartToMaintenance(Number(maint.part_id));
    }
    
    res.json({ success: true, message: 'Service recorded successfully! Status updated.' });
  } catch (err) {
    console.error('Service error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Update current hours/usage
app.put('/api/gse-maintenance/:id/usage', authenticateToken, async (req, res) => {
  const { id } = req.params;
  const { current_hours } = req.body;
  
  try {
    await db.execute({
      sql: `UPDATE gse_maintenance SET current_hours = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
      args: [current_hours, id]
    });
    
    await calculateAndUpdateStatus(Number(id));
    
    res.json({ success: true, message: 'Usage updated, status recalculated' });
  } catch (err) {
    console.error('Update usage error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Delete maintenance item
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
    if (Number(part.quantity_on_hand) < requestQty) {
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
    const convertedData = convertBigInt(result.rows);
    res.json({ success: true, requests: convertedData });
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
    
    const currentStock = Number(partResult.rows[0].quantity_on_hand);
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
    const convertedData = convertBigInt(result.rows);
    res.json({ success: true, requests: convertedData });
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
    const convertedData = convertBigInt(result.rows);
    res.json(convertedData);
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
    const convertedData = convertBigInt(result.rows);
    res.json(convertedData);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ========== USER MANAGEMENT ==========
app.get('/api/users', authenticateToken, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  try {
    const result = await db.execute('SELECT id, username, full_name, role, email FROM users');
    const convertedData = convertBigInt(result.rows);
    res.json(convertedData);
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
  if (Number(req.params.id) === Number(req.user.id)) return res.status(400).json({ error: 'Cannot delete your own account' });
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
    const convertedData = convertBigInt(result.rows);
    res.json({ users: convertedData });
  } catch (err) {
    res.json({ error: err.message });
  }
});

// ========== INITIALIZE ==========
const init = async () => {
  await createTables();
  await createUsers();
  await createSampleData();
  console.log('✅ All data initialized - BigInt conversion enabled!');
};

init();

// ========== START SERVER ==========
app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ GSE Server running on port ${PORT}`);
  console.log(`\n📋 Login with:`);
  console.log(`   admin / admin123 (Admin)`);
  console.log(`   manager / manager123 (Manager)`);
  console.log(`   storekeeper / keeper123 (Storekeeper)`);
  console.log(`\n🔄 Features:`);
  console.log(`   - BigInt values automatically converted to Numbers`);
  console.log(`   - Maintenance schedule auto-updates dashboard status`);
});