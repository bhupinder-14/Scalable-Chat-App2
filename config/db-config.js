const mongoose = require("mongoose");
const { dbUrl } = require("./server-config");

module.exports = async function connectDatabase() {
    await mongoose.connect(dbUrl, { serverSelectionTimeoutMS: 10000 });
};
