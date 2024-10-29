const express = require("express");
const session = require("express-session");
const sqlite3 = require("sqlite3").verbose();
const bcrypt = require("bcrypt");
const multer = require("multer");
const upload = multer({ dest: "public/uploads/" });
const path = require("path");
const sharp = require("sharp");
const fs = require("fs").promises;
const { existsSync, unlinkSync } = require("fs"); // Correctly import sync operations
const { pipeline } = require("stream/promises");
const { exec } = require("child_process");

const app = express();
const db = new sqlite3.Database("./database/books.db");
db.serialize(() => {
  // Create `users` table
  db.run(`CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE,
        password TEXT,
        phone TEXT

    )`);

  // Create `books` table
  db.run(`CREATE TABLE IF NOT EXISTS books (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT,
        author TEXT,
        genre TEXT,
        language TEXT,
        description TEXT,
        photo TEXT,  
        user_id INTEGER,
        FOREIGN KEY(user_id) REFERENCES users(id)
    )`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_genre ON books(genre)`);
});
// Middleware
app.use(express.urlencoded({ extended: true }));
app.use("/uploads", express.static("uploads"));

app.use(express.static("public"));
app.use(
  session({
    secret: "yourSecretKey",
    resave: false,
    saveUninitialized: true,
  })
);

// View Engine
app.set("view engine", "ejs");

// Routes

app.get("/", (req, res) => {
  db.all(`SELECT * FROM books`, [], (err, books) => {
    if (err) {
      console.error(err.message);
      return res.status(500).send("Error retrieving books");
    }
    res.render("index", { user: req.session.user, books, genre: undefined });
  });
});
app.get("/login", (req, res) => {
  res.render("login");
});
app.get("/logout", (req, res) => {
  req.session.destroy((err) => {
    if (err) {
      console.error(err.message);
      return res.status(500).send("Error logging out");
    }
    // Redirect to the home page or login page after logout
    res.redirect("/");
  });
});
app.post("/login", (req, res) => {
  const { username, password } = req.body;

  db.get(`SELECT * FROM users WHERE username = ?`, [username], (err, user) => {
    if (err) {
      console.error(err.message);
      return res.status(500).send("Error retrieving user");
    }
    if (!user) {
      return res.status(401).send("Invalid username or password");
    }

    // Compare the provided password with the stored hash
    bcrypt.compare(password, user.password, (err, result) => {
      if (result) {
        // Passwords match, set session and redirect
        req.session.user = { id: user.id, username: user.username };
        return res.redirect("/");
      } else {
        return res.status(401).send("Invalid username or password");
      }
    });
  });
});
app.get("/register", (req, res) => {
  res.render("register");
});

app.post("/register", (req, res) => {
  const { username, password, phone } = req.body;

  // Hash the password
  bcrypt.hash(password, 10, (err, hash) => {
    if (err) {
      console.error(err.message);
      return res.status(500).send("Error hashing password");
    }

    // Insert the new user into the database
    db.run(
      `INSERT INTO users (username, password, phone) VALUES (?, ?, ?)`,
      [username, hash, phone],
      function (err) {
        if (err) {
          if (err.code === "SQLITE_CONSTRAINT") {
            return res.status(400).send("Username already exists");
          }
          console.error(err.message);
          return res.status(500).send("Error creating user");
        }

        // Redirect to the login page after successful registration
        res.redirect("/login");
      }
    );
  });
});
app.get("/add-book", (req, res) => {
  // Ensure the user is logged in before showing the add book page
  if (!req.session.user) {
    return res.redirect("/login");
  }
  res.render("add-book", { user: req.session.user });
});

app.get("/my-books", (req, res) => {
  // Ensure the user is logged in before showing their books
  if (!req.session.user) {
    return res.redirect("/login");
  }

  const userId = req.session.user.id;

  db.all(`SELECT * FROM books WHERE user_id = ?`, [userId], (err, books) => {
    if (err) {
      console.error(err.message);
      return res.status(500).send("Error retrieving books");
    }
    res.render("my-books", { user: req.session.user, books });
  });
});
app.post("/delete-book/:id", (req, res) => {
  const bookId = req.params.id;

  // First, fetch the book details
  db.get(`SELECT * FROM books WHERE id = ?`, [bookId], (err, book) => {
    if (err) {
      console.error(err.message);
      return res.status(500).send("Error retrieving book");
    }

    if (!book) {
      return res.status(404).send("Book not found");
    }

    // Delete the book from the database
    db.run(`DELETE FROM books WHERE id = ?`, [bookId], function (err) {
      if (err) {
        console.error(err.message);
        return res.status(500).send("Error deleting book");
      }

      // delete the photo file from the filesystem
      //   const photoPath = `${book.photo}`;
      fs.unlink(book.photo, (err) => {
        if (err) {
          console.error(`Error deleting photo: ${err.message}`);
        }
      });

      res.redirect("/my-books");
    });
  });
});
app.get("/book-details/:id", (req, res) => {
  const bookId = req.params.id;

  db.get(
    `SELECT books.*, users.username, users.phone FROM books 
            JOIN users ON books.user_id = users.id WHERE books.id = ?`,
    [bookId],
    (err, book) => {
      if (err) {
        console.error(err.message);
        return res.status(500).send("Error retrieving book details");
      }
      res.json(book);
    }
  );
});
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, "uploads/"); // Set the destination folder for uploaded files
  },
  filename: (req, file, cb) => {
    cb(null, Date.now() + path.extname(file.originalname)); // Rename the file
  },
});

// Handle the book submission
app.post("/add-book", upload.single("photo"), async (req, res) => {
  try {
    const { title, author, genre, language, description } = req.body;
    const userId = req.session.user.id;

    if (!req.file) {
      return res.status(400).send("No photo uploaded");
    }

    const originalPath = req.file.path;
    const filename = path.parse(req.file.filename).name;
    const compressedFilename = `${filename}-compressed.jpg`;
    const compressedPath = path.join(
      path.dirname(originalPath),
      compressedFilename
    );

    // Compress image
    await sharp(originalPath)
      .resize(800, 800, {
        fit: "inside",
        withoutEnlargement: true,
      })
      .jpeg({
        quality: 80,
        mozjpeg: true,
      })
      .toFile(compressedPath);

    // Store the compressed file path
    const photoPath = compressedPath.replace(/\\/g, "/");

    // Add to database
    await new Promise((resolve, reject) => {
      db.run(
        `INSERT INTO books (title, author, genre, language, description, photo, user_id) 
                 VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [title, author, genre, language, description, photoPath, userId],
        function (err) {
          if (err) reject(err);
          else resolve();
        }
      );
    });

    // Delete original file using command line (most reliable method)
    const deleteCommand =
      process.platform === "win32"
        ? `del /f "${originalPath}"`
        : `rm -f "${originalPath}"`;

    await new Promise((resolve, reject) => {
      exec(deleteCommand, (error) => {
        if (error) reject(error);
        else resolve();
      });
    });

    res.redirect("/");
  } catch (error) {
    console.error("Error:", error);
    return res.status(500).send("An error occurred");
  }
});
app.get("/books", (req, res) => {
  const genre = req.query.genre;
  let query = "SELECT * FROM books";
  const params = [];

  // Filter by genre if a genre is specified
  if (genre) {
    query += " WHERE genre = ?";
    params.push(genre);
  }

  db.all(query, params, (err, books) => {
    if (err) {
      console.error(err);
      return res.status(500).send("Error retrieving books.");
    }
    // Render books with the filtered list

    res.render("index", { books, user: req.session.user, genre });
  });
});
app.get("/search", (req, res) => {
  const query = req.query.query.toLowerCase(); // Get the search query

  db.all(
    `SELECT * FROM books WHERE LOWER(title) LIKE ? OR LOWER(author) LIKE ?`,
    [`%${query}%`, `%${query}%`],
    (err, books) => {
      if (err) {
        return res.status(500).send("Error retrieving books");
      }
      res.json({ books }); // Respond with the filtered books
    }
  );
});
// Start Server
app.listen(3000, () => console.log("Server running on http://localhost:3000"));
