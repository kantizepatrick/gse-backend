const sqlite3 = require('sqlite3').verbose();
const { createClient } = require('@libsql/client');

// Turso connection
const turso = createClient({
  url: 'libsql://gse-inventory-kantizepatrick.aws-eu-west-1.turso.io',
  authToken: 'eyJhbGciOiJFZERTQSIsInR5cCI6IkpXVCJ9.eyJhIjoicnciLCJpYXQiOjE3NzkxOTgwOTcsImlkIjoiMDE5ZTQwNzYtNWMwMS03ODIwLWE5NzQtNWQ5OTI4MzE1M2NlIiwicmlkIjoiMGQzZTI2MDQtODg3OC00OTdmLThiMDktZmI2YWY2MWExNzMxIn0.7aqL_8q0hK-ZCgf8IJt0TPrQUI6kQU-ddPIK7lDGB_VeXzJNVU35XUzGaz2ffrQ4z213zFQrOQUIHrlu5jPbDw'
});

// Local SQLite database
const db = new sqlite3.Database('./gse_inventory.db');

console.log('📦 Starting migration to Turso...');
console.log('This will copy ALL your data (parts, users, transactions) to the cloud.\n');

// Drop existing tables in Turso to start fresh
const setupTurso = async () => {
  try {
    await turso.execute(`DROP TABLE IF EXISTS transactions`);
    await turso.execute(`DROP TABLE IF EXISTS parts`);
    await turso.execute(`DROP TABLE IF EXISTS users`);
    console.log('✅ Cleared existing Turso tables');
  } catch (err) {
    console.log('Tables may not exist yet:', err.message);
  }
  
  // Create tables in Turso
  await turso.execute(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    full_name TEXT,
    role TEXT DEFAULT 'storekeeper',
    email TEXT
  )`);
  
  await turso.execute(`CREATE TABLE IF NOT EXISTS parts (
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
  
  await turso.execute(`CREATE TABLE IF NOT EXISTS transactions (
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
  
  console.log('✅ Tables created in Turso\n');
};

// Migrate users
const migrateUsers = () => {
  return new Promise((resolve, reject) => {
    db.all('SELECT * FROM users', [], async (err, users) => {
      if (err) {
        reject(err);
        return;
      }
      console.log(`📋 Found ${users.length} users to migrate`);
      
      for (const user of users) {
        try {
          await turso.execute({
            sql: `INSERT INTO users (id, username, password_hash, full_name, role, email) 
                  VALUES (?, ?, ?, ?, ?, ?)`,
            args: [user.id, user.username, user.password_hash, user.full_name, user.role, user.email]
          });
          console.log(`✅ User: ${user.username}`);
        } catch (err) {
          console.log(`⚠️ User ${user.username} already exists or error:`, err.message);
        }
      }
      resolve();
    });
  });
};

// Migrate parts
const migrateParts = () => {
  return new Promise((resolve, reject) => {
    db.all('SELECT * FROM parts', [], async (err, parts) => {
      if (err) {
        reject(err);
        return;
      }
      console.log(`\n📋 Found ${parts.length} parts to migrate`);
      
      for (const part of parts) {
        try {
          await turso.execute({
            sql: `INSERT INTO parts (id, part_number, description, manufacturer, compatible_gse, location_bin, quantity_on_hand, min_stock, contact_person, contact_phone, contact_email) 
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            args: [part.id, part.part_number, part.description, part.manufacturer, part.compatible_gse, part.location_bin, part.quantity_on_hand, part.min_stock, part.contact_person, part.contact_phone, part.contact_email]
          });
          console.log(`✅ Part: ${part.part_number} (Stock: ${part.quantity_on_hand})`);
        } catch (err) {
          console.log(`⚠️ Part ${part.part_number} error:`, err.message);
        }
      }
      resolve();
    });
  });
};

// Migrate transactions
const migrateTransactions = () => {
  return new Promise((resolve, reject) => {
    db.all('SELECT * FROM transactions', [], async (err, transactions) => {
      if (err) {
        reject(err);
        return;
      }
      console.log(`\n📋 Found ${transactions.length} transactions to migrate`);
      
      for (const tx of transactions) {
        try {
          await turso.execute({
            sql: `INSERT INTO transactions (id, part_id, transaction_type, quantity, gse_registration, technician_name, work_order, reference_number, created_by, notes, created_at) 
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            args: [tx.id, tx.part_id, tx.transaction_type, tx.quantity, tx.gse_registration, tx.technician_name, tx.work_order, tx.reference_number, tx.created_by, tx.notes, tx.created_at]
          });
          console.log(`✅ Transaction ID: ${tx.id} - ${tx.transaction_type} ${tx.quantity} units`);
        } catch (err) {
          console.log(`⚠️ Transaction ${tx.id} error:`, err.message);
        }
      }
      resolve();
    });
  });
};

// Verify migration
const verifyMigration = async () => {
  console.log('\n🔍 Verifying migration...');
  
  const usersResult = await turso.execute('SELECT COUNT(*) as count FROM users');
  const partsResult = await turso.execute('SELECT COUNT(*) as count FROM parts');
  const txResult = await turso.execute('SELECT COUNT(*) as count FROM transactions');
  
  console.log(`\n📊 Turso Database Summary:`);
  console.log(`   Users: ${usersResult.rows[0].count}`);
  console.log(`   Parts: ${partsResult.rows[0].count}`);
  console.log(`   Transactions: ${txResult.rows[0].count}`);
  
  console.log('\n🎉 Migration complete! All your data is now in Turso cloud!');
  console.log('You can now deploy to Render without losing any data.\n');
};

// Run migration
const runMigration = async () => {
  try {
    await setupTurso();
    await migrateUsers();
    await migrateParts();
    await migrateTransactions();
    await verifyMigration();
    process.exit(0);
  } catch (err) {
    console.error('Migration error:', err);
    process.exit(1);
  }
};

runMigration();