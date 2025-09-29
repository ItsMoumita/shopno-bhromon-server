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
     packagesCollection = db.collection("packages");

    console.log("✅ Connected to MongoDB Atlas!");



    // Verify current user is admin
const verifyAdmin = async (req, res, next) => {
  try {
    const email = req.firebaseUser?.email;
    if (!email) return res.status(401).json({ error: "Unauthorized" });

    const currentUser = await usersCollection.findOne({ email });
    if (currentUser?.role !== "admin") {
      return res.status(403).json({ error: "Forbidden: Admins only" });
    }

    next();
  } catch (err) {
    console.error("❌ verifyAdmin error:", err);
    res.status(500).json({ error: "Server error" });
  }
};

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
      role: "user",
      createdAt: new Date(),
    };

    await usersCollection.insertOne(newUser);
    res.status(201).json({ message: "User created ✅", user: newUser });
  } catch (err) {
    console.error("❌ Error saving user:", err);
    res.status(500).json({ error: err.message });
  }
});


// Get user by email (for dashboard)
app.get("/api/users/:email", verifyFirebaseToken, async (req, res) => {
  try {
    const email = req.params.email;
    if (!email) {
      return res.status(400).json({ error: "Email is required" });
    }

    const user = await usersCollection.findOne({ email });
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    res.json(user);
  } catch (err) {
    console.error("❌ Error fetching user:", err);
    res.status(500).json({ error: err.message });
  }
});


// Get all users 
app.get("/api/users", verifyFirebaseToken, async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 5;
    const skip = (page - 1) * limit;

    const users = await usersCollection.find().skip(skip).limit(limit).toArray();
    const total = await usersCollection.countDocuments();

    res.json({
      users: users.map(u => ({
        name: u.name,
        email: u.email,
        role: u.role,
        profilePic: u.profilePic,
        createdAt: u.createdAt,
      })),
      total,
      page,
      pages: Math.ceil(total / limit)
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});



// Update user role (only admin can do this)
app.put("/api/users/:email/role", verifyFirebaseToken, verifyAdmin, async (req, res) => {
  try {
    const targetEmail = req.params.email;
    const { role } = req.body;

    if (!["user", "admin"].includes(role)) {
      return res.status(400).json({ error: "Invalid role" });
    }

    const result = await usersCollection.updateOne(
      { email: targetEmail },
      { $set: { role } }
    );

    if (result.modifiedCount === 0) {
      return res.status(404).json({ message: "User not found " });
    }

    res.json({ message: "Role updated ✅", email: targetEmail, newRole: role });
  } catch (err) {
    console.error("❌ Error updating role:", err);
    res.status(500).json({ error: err.message });
  }
});



    // Add new package (Admin only)
    app.post("/api/packages", verifyFirebaseToken, async (req, res) => {
      try {
        const newPackage = req.body;

        if (!newPackage.title || !newPackage.price) {
          return res.status(400).json({ message: "Title and Price required" });
        }

        newPackage.availability = newPackage.availability ?? true;
        newPackage.validFrom = new Date(newPackage.validFrom);
        newPackage.validTill = new Date(newPackage.validTill);

        const result = await packagesCollection.insertOne(newPackage);
        res.status(201).json({ message: "Package created ✅", package: newPackage });
      } catch (err) {
        console.error("❌ Error adding package:", err);
        res.status(500).json({ error: "Failed to add package" });
      }
    });

    // Get all packages
    app.get("/api/packages", verifyFirebaseToken, async (req, res) => {
      try {
        const packages = await packagesCollection.find().toArray();
        res.json(packages);
      } catch (err) {
        console.error("❌ Error fetching packages:", err);
        res.status(500).json({ error: "Failed to fetch packages" });
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