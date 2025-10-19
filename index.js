require("dotenv").config();
const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const admin = require("firebase-admin");
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
const app = express();
const port = process.env.PORT || 5000;

// Middlewares
app.use(cors({
  origin:[
    'http://localhost:5173',
    'https://shopno-bhromon.web.app'
  ],
  credentials: true,
}));
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
    resortsCollection = db.collection("resorts");
    bookingsCollection = db.collection("bookings");

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
    app.post("/users", async (req, res) => {
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
   app.get("/users/:email", verifyFirebaseToken, async (req, res) => {
  try {
    const targetEmail = req.params.email;
    if (!targetEmail) {
      return res.status(400).json({ error: "Email is required" });
    }

    const user = await usersCollection.findOne({ email: targetEmail });
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    // --- Profile Picture Normalization Logic (Same as for GET /users?recent) ---
    const gravatarUrl = (email) => {
      if (!email) return null;
      const hash = crypto.createHash("md5").update(email.trim().toLowerCase()).digest("hex");
      return `https://www.gravatar.com/avatar/${hash}?d=identicon&s=200`;
    };

    const PLACEHOLDER = "https://placehold.co/200x200/cccccc/555555?text=User";

    const normalizeProfilePic = (raw) => {
      if (!raw) return null;
      const s = String(raw).trim();
      // Fix common typos/malformed URLs if any
      const fixed = s.replaceAll(".ibb.co.com", ".ibb.co");
      if (/^https?:\/\//i.test(fixed)) return fixed; // Is it a valid http(s) URL?
      return null; // Not a valid web URL
    };

    const profilePic =
      normalizeProfilePic(user.profilePic) || // Check user.profilePic first
      normalizeProfilePic(user.photoURL) ||   // Then check user.photoURL from Firebase
      gravatarUrl(user.email) ||              // Then generate Gravatar
      PLACEHOLDER;                            // Finally, a generic placeholder

    // Construct the user object to send to the frontend
    const userResponse = {
      _id: user._id?.toString ? user._id.toString() : user._id, // Ensure _id is string
      name: user.name || user.displayName || null, // Prefer DB name, fallback to Firebase's displayName
      email: user.email || null,
      role: user.role || "user", // Default role if not set
      profilePic: profilePic, // The normalized and reliable profile picture URL
      createdAt: user.createdAt ? user.createdAt.toISOString() : null,
      // Add any other user fields you want to expose
    };

    res.json(userResponse);
  } catch (err) {
    console.error("❌ Error fetching user:", err);
    res.status(500).json({ error: err.message });
  }
});


    // Get all users 
    app.get("/users", verifyFirebaseToken, async (req, res) => {
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



    // Update user role
    app.put("/users/:email/role", verifyFirebaseToken, verifyAdmin, async (req, res) => {
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



    // Add new package 
    app.post("/packages", verifyFirebaseToken, async (req, res) => {
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




    app.get("/packages", async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 0;

    const packages = await packagesCollection
      .find()
      .sort({ createdAt: -1 })  
      .limit(limit)
      .toArray();

    res.json(packages);
  } catch (err) {
    console.error("❌ Error fetching packages:", err.message);
    res.status(500).json({ error: "Failed to fetch packages" });
  }
});



    // Update package
    app.put("/packages/:id", verifyFirebaseToken, async (req, res) => {
      try {
        const id = req.params.id;
        const updates = req.body;
        delete updates._id;

        const result = await packagesCollection.updateOne(
          { _id: new ObjectId(id) },   
          { $set: { ...updates, updatedAt: new Date() } }
        );

        if (result.matchedCount === 0) {
          return res.status(404).json({ message: "Package not found" });
        }

        res.json({ message: "✅ Package updated successfully" });
      } catch (err) {
        console.error("❌ Error updating package:", err.message);
        res.status(500).json({ error: "Failed to update package" });
      }
    });

    // Delete package 
    app.delete("/packages/:id", verifyFirebaseToken, async (req, res) => {
      try {
        const id = req.params.id;
        const result = await packagesCollection.deleteOne({ _id: new ObjectId(id) });

        if (result.deletedCount === 0) {
          return res.status(404).json({ message: "Package not found" });
        }

        res.json({ message: "✅ Package deleted successfully" });
      } catch (err) {
        console.error("❌ Error deleting package:", err.message);
        res.status(500).json({ error: "Failed to delete package" });
      }
    });



    // Get single package by ID
    app.get("/packages/:id", async (req, res) => {
      try {

        const id = req.params.id;

        if (!ObjectId.isValid(id)) {
          return res.status(400).json({ error: "Invalid package ID format" });
        }

        const pkg = await packagesCollection.findOne({ _id: new ObjectId(id) });

        if (!pkg) {
          return res.status(404).json({ message: "Package not found" });
        }

        res.json(pkg);
      } catch (err) {
        console.error("❌ Error fetching single package:", err.message);
        res.status(500).json({ error: "Failed to fetch package details" });
      }
    });



    // --- ADD Resort ---
    app.post("/resorts", verifyFirebaseToken, async (req, res) => {
      try {
        const newResort = req.body;

        if (!newResort.name || !newResort.location) {
          return res.status(400).json({ error: "Name and Location required" });
        }

        newResort.createdAt = new Date();

        await resortsCollection.insertOne(newResort);

        res.status(201).json({ message: "Resort added ✅", resort: newResort });
      } catch (err) {
        console.error("❌ Error adding resort:", err);
        res.status(500).json({ error: "Failed to add resort" });
      }
    });

    // Get all resorts (for carousel and listing)
app.get("/resorts", async (req, res) => {
  try {
  //  support limit query param for carousel
    const limit = parseInt(req.query.limit) || 0;

    const cursor = resortsCollection.find().sort({ createdAt: -1 });
    const resorts = limit ? await cursor.limit(limit).toArray() : await cursor.toArray();

    
    resorts.forEach((r) => {
      if (Array.isArray(r.amenities)) {
        r.amenities = r.amenities.map((a) => a.trim());
      }
    });

    res.json(resorts);
  } catch (err) {
    console.error("❌ Error fetching resorts:", err);
    res.status(500).json({ error: "Failed to fetch resorts" });
  }
});

    // --- GET Resort by ID ---
    app.get("/resorts/:id", async (req, res) => {
  try {
    const { id } = req.params;

    if (!id) {
      return res.status(400).json({ error: "Missing resort id" });
    }

    if (!ObjectId.isValid(id)) {
      return res.status(400).json({ error: "Invalid resort id format" });
    }

    const resort = await resortsCollection.findOne({ _id: new ObjectId(id) });

    if (!resort) {
      return res.status(404).json({ message: "Resort not found" });
    }

    // trim amenities spaces before sending
    if (Array.isArray(resort.amenities)) {
      resort.amenities = resort.amenities.map((a) => a.trim());
    }

    res.json(resort);
  } catch (err) {
    console.error("❌ Error fetching resort by ID:", err.message);
    res.status(500).json({ error: "Failed to fetch resort" });
  }
});


// update resort 
app.put("/resorts/:id", verifyFirebaseToken, async (req, res) => {
  try {
    const id = req.params.id;
    const updates = req.body;

    delete updates._id;

    // Convert id to ObjectId
    if (!ObjectId.isValid(id)) {
      return res.status(400).json({ error: "Invalid resort ID" });
    }

    const result = await resortsCollection.updateOne(
      { _id: new ObjectId(id) },
      { $set: { ...updates, updatedAt: new Date() } }
    );

    if (result.matchedCount === 0) {
      return res.status(404).json({ message: "Resort not found" });
    }

    res.json({ message: "Resort updated successfully" });
  } catch (err) {
    console.error("Error updating resort:", err);
    res.status(500).json({ error: "Failed to update resort" });
  }
});


// delete resort 
app.delete("/resorts/:id", verifyFirebaseToken, async (req, res) => {
  try {
    const id = req.params.id;

    if (!ObjectId.isValid(id)) {
      return res.status(400).json({ error: "Invalid resort ID" });
    }

    const result = await resortsCollection.deleteOne({ _id: new ObjectId(id) });

    if (result.deletedCount === 0) {
      return res.status(404).json({ message: "Resort not found" });
    }

    res.json({ message: "Resort deleted successfully" });
  } catch (err) {
    console.error("Error deleting resort:", err);
    res.status(500).json({ error: "Failed to delete resort" });
  }
});




// ----------------------payment api-------------------------------------------------- 

// Create PaymentIntent 
app.post("/create-payment-intent", verifyFirebaseToken, async (req, res) => {
  try {
    const { itemType, itemId, nights, guests, startDate } = req.body;
    if (!itemType || !itemId) return res.status(400).json({ error: "Missing itemType or itemId" });

    // Load item 
    let itemDoc = null;
    if (ObjectId.isValid(itemId)) {
      const oid = new ObjectId(itemId);
      itemDoc = itemType === "package"
        ? await packagesCollection.findOne({ _id: oid })
        : await resortsCollection.findOne({ _id: oid });
    } else {
      itemDoc = itemType === "package"
        ? await packagesCollection.findOne({ _id: itemId })
        : await resortsCollection.findOne({ _id: itemId });
    }
    if (!itemDoc) return res.status(404).json({ error: "Item not found" });

    // Compute amount (in display currency)
    
    let amountRaw = 0;
    if (itemType === "package") {
      const perPerson = Number(itemDoc.price || 0);
      amountRaw = perPerson * (Number(guests) || 1);
    } else {
      const perNight = Number(itemDoc.pricePerNight || itemDoc.price || 0);
      amountRaw = perNight * (Number(nights) || 1);
    }

    // Currency and smallest unit conversion
    const currency = process.env.STRIPE_CURRENCY || "usd"; 
   
    const amount = Math.round(amountRaw * 100);

    // Create PaymentIntent
    const paymentIntent = await stripe.paymentIntents.create({
      amount,
      currency,
      metadata: {
        itemType,
        itemId: itemDoc._id.toString(),
        userEmail: req.firebaseUser?.email || "",
      },
    });

    res.json({ clientSecret: paymentIntent.client_secret, amount, currency });
  } catch (err) {
    console.error("Error creating payment intent:", err);
    res.status(500).json({ error: "Failed to create payment intent" });
  }
});

// Confirm booking after payment (authenticated)
app.post("/bookings/confirm", verifyFirebaseToken, async (req, res) => {
  try {
    const { paymentIntentId, itemType, itemId, nights, guests, startDate, note } = req.body;
    if (!paymentIntentId || !itemType || !itemId) return res.status(400).json({ error: "Missing fields" });

    // Retrieve PaymentIntent from Stripe
    const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);
    if (!paymentIntent || paymentIntent.status !== "succeeded") {
      return res.status(400).json({ error: "Payment not successful" });
    }

    // Load the item to reference details and verify amount server-side
    let itemDoc = null;
    if (ObjectId.isValid(itemId)) {
      const oid = new ObjectId(itemId);
      itemDoc = itemType === "package"
        ? await packagesCollection.findOne({ _id: oid })
        : await resortsCollection.findOne({ _id: oid });
    } else {
      itemDoc = itemType === "package"
        ? await packagesCollection.findOne({ _id: itemId })
        : await resortsCollection.findOne({ _id: itemId });
    }
    if (!itemDoc) return res.status(404).json({ error: "Item not found" });

    let expectedAmountRaw = 0;
    if (itemType === "package") {
      const perPerson = Number(itemDoc.price || 0);
      expectedAmountRaw = perPerson * (Number(guests) || 1);
    } else {
      const perNight = Number(itemDoc.pricePerNight || itemDoc.price || 0);
      expectedAmountRaw = perNight * (Number(nights) || 1);
    }
    const expectedAmount = Math.round(expectedAmountRaw * 100);

    //  verify amounts match
    if (paymentIntent.amount !== expectedAmount) {
      console.warn("Payment amount mismatch:", paymentIntent.amount, expectedAmount);
      
    }

    // Create booking record
    const booking = {
      userId: req.firebaseUser?.uid || null,
      userEmail: req.firebaseUser?.email || null,
      itemType,
      itemId: itemDoc._id.toString(),
      itemTitle: itemDoc.title || itemDoc.name || "",
      startDate: startDate ? new Date(startDate) : null,
      nights: nights ? Number(nights) : null,
      guests: guests ? Number(guests) : 1,
      note: note || "",
      amount: paymentIntent.amount / 100,
      currency: paymentIntent.currency,
      paymentId: paymentIntent.id,
      status: "paid",
      createdAt: new Date(),
    };

    const result = await bookingsCollection.insertOne(booking);
    res.json({ message: "Booking confirmed", bookingId: result.insertedId.toString() });
  } catch (err) {
    console.error("Error confirming booking:", err);
    res.status(500).json({ error: "Failed to confirm booking" });
  }
});




// ---------------api for bookings---------------------------------------------- 

/**
 * GET /bookings/user

 */
app.get("/bookings/user", verifyFirebaseToken, async (req, res) => {
  try {
    const email = req.firebaseUser?.email;
    if (!email) return res.status(400).json({ error: "Invalid user" });

    const docs = await bookingsCollection.find({ userEmail: email }).sort({ createdAt: -1 }).toArray();

    
    const bookings = docs.map((b) => ({
      ...b,
      _id: b._id?.toString?.() ?? b._id,
      createdAt: b.createdAt ? b.createdAt.toISOString() : null,
      startDate: b.startDate ? new Date(b.startDate).toISOString() : null,
    }));

    res.json(bookings);
  } catch (err) {
    console.error("❌ Error fetching user bookings:", err);
    res.status(500).json({ error: "Failed to fetch bookings" });
  }
});

/**
 * DELETE /bookings/:id
 */
app.delete("/bookings/:id", verifyFirebaseToken, async (req, res) => {
  try {
    const id = req.params.id;
    if (!ObjectId.isValid(id)) return res.status(400).json({ error: "Invalid booking id" });

    const booking = await bookingsCollection.findOne({ _id: new ObjectId(id) });
    if (!booking) return res.status(404).json({ error: "Booking not found" });

    const requesterEmail = req.firebaseUser?.email;
  
    if (booking.userEmail !== requesterEmail) {
      const currentUser = await usersCollection.findOne({ email: requesterEmail });
      if (!currentUser || currentUser.role !== "admin") {
        return res.status(403).json({ error: "Forbidden" });
      }
    }

    const result = await bookingsCollection.deleteOne({ _id: new ObjectId(id) });
    if (result.deletedCount === 0) {
      return res.status(500).json({ error: "Failed to delete booking" });
    }

    res.json({ message: "Booking removed" });
  } catch (err) {
    console.error("❌ Error deleting booking:", err);
    res.status(500).json({ error: "Failed to delete booking" });
  }
});


app.get("/bookings", verifyFirebaseToken, verifyAdmin, async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.max(1, parseInt(req.query.limit) || 20);
    const skip = (page - 1) * limit;

    const total = await bookingsCollection.countDocuments();
    const docs = await bookingsCollection.find().sort({ createdAt: -1 }).skip(skip).limit(limit).toArray();

    const bookings = docs.map((b) => ({
      ...b,
      _id: b._id?.toString?.() ?? b._id,
      createdAt: b.createdAt ? b.createdAt.toISOString() : null,
      startDate: b.startDate ? new Date(b.startDate).toISOString() : null,
    }));

    res.json({
      bookings,
      total,
      page,
      pages: Math.ceil(total / limit),
    });
  } catch (err) {
    console.error("❌ Error fetching all bookings:", err);
    res.status(500).json({ error: "Failed to fetch bookings" });
  }
});

// Get booking by ID - admin only
app.get("/bookings/:id", verifyFirebaseToken, verifyAdmin, async (req, res) => {
  try {
    const id = req.params.id;
    if (!ObjectId.isValid(id)) return res.status(400).json({ error: "Invalid booking id" });

    const b = await bookingsCollection.findOne({ _id: new ObjectId(id) });
    if (!b) return res.status(404).json({ error: "Booking not found" });

    const booking = {
      ...b,
      _id: b._id?.toString?.() ?? b._id,
      createdAt: b.createdAt ? b.createdAt.toISOString() : null,
      startDate: b.startDate ? new Date(b.startDate).toISOString() : null,
    };
    res.json(booking);
  } catch (err) {
    console.error("❌ Error fetching booking by id:", err);
    res.status(500).json({ error: "Failed to fetch booking" });
  }
});





// Admin overview: counts and simple percent changes
app.get("/admin/overview", verifyFirebaseToken, verifyAdmin, async (req, res) => {
  try {
    const days = parseInt(req.query.days) || 30;

    const end = new Date(); // now
    const start = new Date(end);
    start.setDate(end.getDate() - days);

    const prevEnd = new Date(start);
    const prevStart = new Date(prevEnd);
    prevStart.setDate(prevEnd.getDate() - days);

    
    const safeCount = async (collection, filter = {}) => {
      if (!collection) return 0;
      try {
        return await collection.countDocuments(filter);
      } catch (err) {
        console.error("countDocuments error:", err);
        return 0;
      }
    };

    // Bookings in current and previous periods 
    const totalBookings = await safeCount(bookingsCollection, {
      createdAt: { $gte: start, $lt: end },
    });
    const prevBookings = await safeCount(bookingsCollection, {
      createdAt: { $gte: prevStart, $lt: prevEnd },
    });

    // Users
    const totalUsers = await safeCount(usersCollection);
    const newUsers = await safeCount(usersCollection, {
      createdAt: { $gte: start, $lt: end },
    });
    const prevNewUsers = await safeCount(usersCollection, {
      createdAt: { $gte: prevStart, $lt: prevEnd },
    });

    // Packages & Resorts counts
    const packagesCount = await safeCount(packagesCollection);
    const resortsCount = await safeCount(resortsCollection);

    // percent change helper
    const percentChange = (current, previous) => {
      if (previous === 0) return current === 0 ? 0 : 100;
      return Math.round(((current - previous) / previous) * 100);
    };

    const bookingsChangePercent = percentChange(totalBookings, prevBookings);
    const usersChangePercent = percentChange(newUsers, prevNewUsers);

    res.json({
      totalBookings,
      bookingsChangePercent,
      totalUsers,
      newUsers,
      usersChangePercent,
      packagesCount,
      resortsCount,
    });
  } catch (err) {
    console.error("❌ Error building admin overview:", err.stack || err);
    res.status(500).json({ error: "Failed to fetch admin overview" });
  }
});








// Admin: get bookings
app.get("/bookings", verifyFirebaseToken, verifyAdmin, async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.max(1, parseInt(req.query.limit) || 10);
    const skip = (page - 1) * limit;

    const total = await bookingsCollection.countDocuments();
    const docs = await bookingsCollection.find().sort({ createdAt: -1 }).skip(skip).limit(limit).toArray();

    const bookings = docs.map(b => ({
      ...b,
      _id: b._id?.toString?.() ?? b._id,
      createdAt: b.createdAt ? b.createdAt.toISOString() : null,
      startDate: b.startDate ? new Date(b.startDate).toISOString() : null,
    }));

    res.json({ bookings, total, page, pages: Math.ceil(total / limit) });
  } catch (err) {
    console.error("Error fetching bookings:", err);
    res.status(500).json({ error: "Failed to fetch bookings" });
  }
});


// Delete booking 
app.delete("/bookings/:id", verifyFirebaseToken, async (req, res) => {
  try {
    const id = req.params.id;
    if (!ObjectId.isValid(id)) return res.status(400).json({ error: "Invalid booking id" });

    const booking = await bookingsCollection.findOne({ _id: new ObjectId(id) });
    if (!booking) return res.status(404).json({ error: "Booking not found" });

   
    const requesterEmail = req.firebaseUser?.email;
    if (booking.userEmail !== requesterEmail) {
      const currentUser = await usersCollection.findOne({ email: requesterEmail });
      if (!currentUser || currentUser.role !== "admin") {
        return res.status(403).json({ error: "Forbidden" });
      }
    }

    const result = await bookingsCollection.deleteOne({ _id: new ObjectId(id) });
    if (result.deletedCount === 0) return res.status(500).json({ error: "Failed to delete" });

    res.json({ message: "Booking deleted" });
  } catch (err) {
    console.error("Error deleting booking:", err);
    res.status(500).json({ error: "Failed to delete booking" });
  }
});





// Start server
app.listen(port, () => {
  console.log(`🚀 Travel Server running on http://localhost:${port}`);
});






  } catch (err) {
    console.error("❌ MongoDB connection failed:", err);
  }
}
run().catch(console.dir);

