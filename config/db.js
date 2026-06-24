const mongoose = require('mongoose');

const RETRY_DELAY_MS = 5000;

async function connectDB() {
  try {
    await mongoose.connect(process.env.MONGODB_URI);
  } catch (err) {
    console.error(`[DB] Connection failed: ${err.message}. Retrying in ${RETRY_DELAY_MS / 1000}s…`);
    setTimeout(connectDB, RETRY_DELAY_MS);
  }
}

mongoose.connection.on('connected', () => {
  console.log(`[DB] Connected to MongoDB Atlas`);
});

mongoose.connection.on('error', (err) => {
  console.error(`[DB] Mongoose error: ${err.message}`);
});

mongoose.connection.on('disconnected', () => {
  console.warn('[DB] Disconnected from MongoDB. Attempting reconnect…');
  setTimeout(connectDB, RETRY_DELAY_MS);
});

module.exports = connectDB;
