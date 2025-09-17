require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { MongoClient, ServerApiVersion } = require("mongodb");
const admin = require("firebase-admin");

const app = express();
const port = process.env.PORT || 5000;

// Middlewares
app.use(cors());
app.use(express.json());

app.get("/", (req, res) => {
  res.send("Travel Server is Running ✅");
});

// Firebase Admin init
var serviceAccount = require("./shopno-bhromon-firebase-adminsdk-fbsvc-e341be1522.json");
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

// MongoDB client
const uri = `mongodb+srv://${process.env.DB_USERNAME}:${process.env.DB_PASSWORD}@cluster0.sytrtnz.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0`;
const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

let usersCollection;

// Token verification middleware
const verifyFirebaseToken = async (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ message: "Unauthorized: No token provided" });
  }
  const idToken = authHeader.split(" ")[1];
  try {
    const decodedToken = await admin.auth().verifyIdToken(idToken);
    req.firebaseUser = decodedToken;
    next();
  } catch (error) {
    return res.status(401).json({ message: "Unauthorized: Invalid token" });
  }
};

// Connect DB and setup routes
async function run() {
  try {
    await client.connect();
    const db = client.db("traveldb");
    usersCollection = db.collection("users");
    console.log("✅ Connected to MongoDB Atlas!");

    // --- ROUTES ---
    app.post("/api/users", async (req, res) => {
      try {
        const { name, email, profilePic } = req.body;
        if (!email) {
          return res.status(400).json({ error: "Email is required" });
        }

        const existingUser = await usersCollection.findOne({ email });
        if (existingUser) {
          return res
            .status(200)
            .json({ message: "User already exists", user: existingUser });
        }

        const newUser = {
          name,
          email,
          profilePic,
          createdAt: new Date(),
        };

        await usersCollection.insertOne(newUser);
        res.status(201).json({ message: "User created ✅", user: newUser });
      } catch (err) {
        console.error("❌ Error saving user:", err);
        res.status(500).json({ error: err.message });
      }
    });
  } catch (err) {
    console.error("❌ MongoDB connection failed:", err);
  }
}
run().catch(console.dir);

// Start server
app.listen(port, () => {
  console.log(`🚀 Travel Server running on http://localhost:${port}`);
});