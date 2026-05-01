import dotenv from "dotenv";
dotenv.config();

import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";

import express from "express";
import cookieParser from "cookie-parser";
import { Server, Socket } from "socket.io";

import { publisher, redis, subscriber } from "./redis-connection.js";
import {
	createSession,
	getSession,
	isSessionValid,
	destroySession,
} from "./session-manager.js";
import {
	verifySessionInRoute,
	verifySocketSession,
} from "./auth-middleware.js";
import {
	getAuthorizationUrl,
	exchangeCodeForTokens,
	getUserInfo,
} from "./auth-service.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const CHECKBOX_SIZE = 100000;
const CHECKBOX_STATE_KEY = "checkbox-state:v1";

const socketUserMap = new Map();

function isUsableSession(session) {
	return Boolean(session && session.userId && session.email);
}

async function main() {
	const app = express();

	const server = http.createServer(app);
	const PORT = process.env.PORT ?? 3000;

	const io = new Server({
		cors: {
			origin: process.env.CLIENT_URL || "http://localhost:3000",
			credentials: true,
		},
	});
	io.attach(server);

	// Middleware
	app.use(cookieParser());
	app.use(express.json());
	app.use(express.static(path.resolve(process.cwd(), "public")));

	await subscriber.subscribe("internel-server:checkbox:change");
	subscriber.on("message", (channel, message) => {
		if (channel === "internel-server:checkbox:change") {
			const data = JSON.parse(message);
			io.emit("server:checkbox:change", {
				i: data.i,
				checked: data.checked,
				userId: data.userId,
				userName: data.userName,
				timestamp: data.timestamp,
			});
		}
	});

	/**
	 * Route: GET /auth/login
	 * Initiates OAuth 2.0 Authorization Code Flow
	 */
	app.get("/auth/login", (req, res) => {
		try {
			const { url, state, nonce, codeVerifier } = getAuthorizationUrl();

			// Store state and codeVerifier temporarily (10 minutes validity)
			const stateKey = `auth-state:${state}`;
			redis
				.setex(stateKey, 600, JSON.stringify({ nonce, codeVerifier }))
				.catch((err) => {
					console.error("Failed to store auth state:", err);
				});

			// Traditional server-side redirect (keeps flow intact)
			res.redirect(url);
		} catch (error) {
			console.error("Login initiation failed:", error);
			res.status(500).json({ error: "Failed to initiate login" });
		}
	});

	/**
	 * Route: GET /auth/login-url
	 * Returns the provider authorization URL as JSON so the client can redirect directly
	 */
	app.get("/auth/login-url", (req, res) => {
		try {
			const { url, state, nonce, codeVerifier } = getAuthorizationUrl();
			const stateKey = `auth-state:${state}`;
			redis
				.setex(stateKey, 600, JSON.stringify({ nonce, codeVerifier }))
				.catch((err) => {
					console.error("Failed to store auth state:", err);
				});
			res.json({ url });
		} catch (error) {
			console.error("Failed to build login URL:", error);
			res.status(500).json({ error: "Failed to build login URL" });
		}
	});

	/**
	 * Route: GET /auth/callback
	 * OAuth 2.0 callback - exchanges code for tokens
	 */
	app.get("/auth/callback", async (req, res) => {
		const { code, state, error } = req.query;

		if (error) {
			console.error("Auth error:", error);
			return res.status(400).redirect(`/?error=${encodeURIComponent(error)}`);
		}

		if (!code || !state) {
			return res.status(400).redirect("/?error=Missing+code+or+state");
		}

		try {
			// Retrieve and validate stored state
			const stateKey = `auth-state:${state}`;
			const storedData = await redis.get(stateKey);

			if (!storedData) {
				return res.status(400).redirect("/?error=Invalid+state");
			}

			const { nonce, codeVerifier } = JSON.parse(storedData);
			await redis.del(stateKey);

			// Exchange authorization code for tokens
			const tokenData = await exchangeCodeForTokens(code, codeVerifier);

			// Fetch user information
			const userInfo = await getUserInfo(tokenData.accessToken);

			// Create session with unique ID
			const sessionId = crypto.randomUUID();
			await createSession(sessionId, {
				...userInfo,
				accessToken: tokenData.accessToken,
				refreshToken: tokenData.refreshToken,
				expiresIn: tokenData.expiresIn,
			});

			// Set secure HTTP-only cookie
			res.cookie("sessionId", sessionId, {
				httpOnly: true,
				secure: process.env.NODE_ENV === "production",
				sameSite: "lax",
				maxAge: 24 * 60 * 60 * 1000, // 24 hours
			});

			// Redirect to dashboard
			res.redirect("/dashboard.html");
		} catch (error) {
			console.error("Authentication callback failed:", error);
			res.status(500).redirect("/?error=Authentication+failed");
		}
	});

	/**
	 * Route: GET /auth/logout
	 * Destroy session and logout user
	 */
	app.get("/auth/logout", async (req, res) => {
		const sessionId = req.cookies?.sessionId;

		if (sessionId) {
			// Destroy session in Redis
			await destroySession(sessionId);

			// Disconnect all socket connections for this user
			const socketsToDisconnect = Array.from(socketUserMap.entries())
				.filter(([, sid]) => sid === sessionId)
				.map(([sockId]) => sockId);

			for (const sockId of socketsToDisconnect) {
				const sock = io.sockets.sockets.get(sockId);
				if (sock) {
					sock.disconnect(true);
				}
				socketUserMap.delete(sockId);
			}
		}

		res.clearCookie("sessionId");
		res.redirect("/");
	});

	/**
	 * Route: GET /auth/user
	 * Get current authenticated user information
	 */
	app.get("/auth/user", verifySessionInRoute, (req, res) => {
		if (!isUsableSession(req.user)) {
			res.clearCookie("sessionId");
			return res.status(401).json({ error: "Unauthorized" });
		}

		res.json({
			user: {
				id: req.user.userId,
				email: req.user.email,
				name: req.user.name,
				picture: req.user.picture,
			},
		});
	});

	/**
	 * Route: GET /auth/status
	 * Check if user is authenticated
	 */
	app.get("/auth/status", async (req, res) => {
		const sessionId = req.cookies?.sessionId;

		if (!sessionId) {
			return res.json({ authenticated: false });
		}

		const isValid = await isSessionValid(sessionId);
		if (!isValid) {
			res.clearCookie("sessionId");
			return res.json({ authenticated: false });
		}

		const session = await getSession(sessionId);
		if (!isUsableSession(session)) {
			res.clearCookie("sessionId");
			return res.json({ authenticated: false });
		}
		res.json({
			authenticated: true,
			user: {
				id: session.userId,
				email: session.email,
				name: session.name,
			},
		});
	});

	/**
	 * Socket.IO middleware: Verify authentication before connection
	 */
	io.use(async (socket, next) => {
		try {
			// Extract sessionId from cookie header
			const cookies = socket.handshake.headers.cookie || "";
			const sessionId = cookies
				.split("; ")
				.find((cookie) => cookie.startsWith("sessionId="))
				?.split("=")[1];

			if (!sessionId) {
				return next(new Error("Authentication error: No session found"));
			}

			// Verify session is valid
			const isValid = await isSessionValid(sessionId);
			if (!isValid) {
				return next(
					new Error("Authentication error: Invalid or expired session"),
				);
			}

			// Get session data
			const session = await getSession(sessionId);
			if (!session) {
				return next(new Error("Authentication error: Session not found"));
			}
			if (!isUsableSession(session)) {
				return next(
					new Error("Authentication error: Incomplete session user data"),
				);
			}

			// Attach user data to socket
			socket.sessionId = sessionId;
			socket.userId = session.userId;
			socket.user = {
				id: session.userId,
				email: session.email,
				name: session.name,
			};

			// Map socket to session
			socketUserMap.set(socket.id, sessionId);

			next();
		} catch (error) {
			console.error("Socket authentication error:", error);
			next(error);
		}
	});

	// Socket event handlers
	io.on("connection", (socket) => {
		console.log("socket connected", {
			id: socket.id,
			userId: socket.userId,
			email: socket.user.email,
			name: socket.user.name,
		});

		socket.on("disconnect", () => {
			console.log("socket disconnected", {
				id: socket.id,
				userId: socket.userId,
			});
			socketUserMap.delete(socket.id);
		});

		socket.on("client:checkbox:change", async (data) => {
			console.log(
				`[socket:${socket.id}][user:${socket.userId}]:client:checkbox:change`,
				data,
			);

			try {
				// Rate limiting per authenticated user
				const rateLimitKey = `rate-limit:${socket.userId}`;
				const lastOperationTime = await redis.get(rateLimitKey);

				if (lastOperationTime) {
					const timeElapsed = Date.now() - parseInt(lastOperationTime);
					if (timeElapsed < 5.5 * 1000) {
						socket.emit("server:error", {
							message: "Rate limit exceeded. Please wait before trying again.",
						});
						return;
					}
				}

				// Update rate limit timestamp
				await redis.set(rateLimitKey, Date.now().toString());

				// Update checkbox state
				const existingState = await redis.get(CHECKBOX_STATE_KEY);
				if (existingState) {
					const remoteData = JSON.parse(existingState);
					remoteData[data.i] = data.checked;
					await redis.set(CHECKBOX_STATE_KEY, JSON.stringify(remoteData));
				} else {
					const initialState = new Array(CHECKBOX_SIZE).fill(false);
					initialState[data.i] = data.checked;
					await redis.set(CHECKBOX_STATE_KEY, JSON.stringify(initialState));
				}

				// Publish change with user information
				publisher.publish(
					"internel-server:checkbox:change",
					JSON.stringify({
						i: data.i,
						checked: data.checked,
						userId: socket.userId,
						userName: socket.user.name,
						timestamp: Date.now(),
					}),
				);

				// Emit success response
				socket.emit("server:checkbox:updated", {
					i: data.i,
					checked: data.checked,
				});
			} catch (error) {
				console.error("Error handling checkbox change:", error);
				socket.emit("server:error", { message: "Failed to update checkbox" });
			}
		});
	});

	/**
	 * Route: GET /health
	 * Health check endpoint
	 */
	app.get("/health", (req, res) => {
		res.status(200).json({ healthy: true });
	});

	/**
	 * Route: GET /checkboxes
	 * Get all checkbox states (requires authentication)
	 */
	app.get("/checkboxes", verifySessionInRoute, async (req, res) => {
		try {
			const existingState = await redis.get(CHECKBOX_STATE_KEY);
			if (existingState) {
				res.status(200).json({ checkboxes: JSON.parse(existingState) });
			} else {
				const initialState = new Array(CHECKBOX_SIZE).fill(false);
				await redis.set(CHECKBOX_STATE_KEY, JSON.stringify(initialState));
				res.status(200).json({ checkboxes: initialState });
			}
		} catch (error) {
			console.error("Error fetching checkboxes:", error);
			res.status(500).json({ error: "Failed to fetch checkboxes" });
		}
	});

	server.listen(PORT, () => {
		console.log(`🚀 Server is running on http://localhost:${PORT}`);
		console.log(
			`🔐 OIDC Issuer: ${process.env.OIDC_ISSUER || "http://localhost:8000"}`,
		);
	});
}

main().catch((err) => {
	console.error("Server startup error:", err);
	process.exit(1);
});
