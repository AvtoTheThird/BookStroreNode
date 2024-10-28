const express = require("express");
const session = require("express-session");
const sqlite3 = require("sqlite3").verbose();
const bcrypt = require("bcrypt");
const multer = require("multer");
const upload = multer({ dest: "public/uploads/" });
const path = require("path");
const fs = require("fs");

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
app.post("/add-book", upload.single("photo"), (req, res) => {
  console.log(req.body);

  const { title, author, genre, language, description } = req.body;
  const photoPath = req.file.path.replace(/\\/g, "/"); // Replace backslashes with forward slashes
  const userId = req.session.user.id;
  console.log(photoPath);

  // Store only the relative path
  db.run(
    `INSERT INTO books (title, author, genre, language, description, photo, user_id) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [title, author, genre, language, description, photoPath, userId],
    function (err) {
      if (err) {
        console.error(err.message);
        return res.status(500).send("Error adding book");
      }
      res.redirect("/");
    }
  );
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
// Start Server
app.listen(3000, () => console.log("Server running on http://localhost:3000"));
