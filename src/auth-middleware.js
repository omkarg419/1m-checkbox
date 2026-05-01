import { getSession, isSessionValid } from "./session-manager.js";

/**
 * Express middleware to verify user is authenticated
 */
export function requireAuth(req, res, next) {
	const sessionId = req.cookies?.sessionId;

	if (!sessionId) {
		return res.status(401).json({ error: "Unauthorized" });
	}

	next();
}

/**
 * Verify session in route handler
 */
export async function verifySessionInRoute(req, res, next) {
	const sessionId = req.cookies?.sessionId;

	if (!sessionId) {
		return res.status(401).json({ error: "Unauthorized: No session" });
	}

	const isValid = await isSessionValid(sessionId);
	if (!isValid) {
		return res
			.status(401)
			.json({ error: "Unauthorized: Invalid or expired session" });
	}

	const session = await getSession(sessionId);
	req.user = session;
	req.sessionId = sessionId;
	next();
}

/**
 * Verify Socket.IO session
 */
export async function verifySocketSession(sessionId) {
	if (!sessionId) return null;

	const isValid = await isSessionValid(sessionId);
	if (!isValid) return null;

	return await getSession(sessionId);
}
