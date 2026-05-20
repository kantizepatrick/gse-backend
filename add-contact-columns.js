const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('./gse_inventory.db');

db.run("ALTER TABLE parts ADD COLUMN contact_person TEXT", [], (err) => {
  if(err) console.log('contact_person column may already exist');
  else console.log('✅ contact_person column added');
});

db.run("ALTER TABLE parts ADD COLUMN contact_phone TEXT", [], (err) => {
  if(err) console.log('contact_phone column may already exist');
  else console.log('✅ contact_phone column added');
});

db.run("ALTER TABLE parts ADD COLUMN contact_email TEXT", [], (err) => {
  if(err) console.log('contact_email column may already exist');
  else console.log('✅ contact_email column added');
});

setTimeout(() => {
  console.log('✅ Database updated with manufacturer contact fields');
  db.close();
}, 1000);