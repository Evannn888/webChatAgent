/**
 * GET /api/auth/me → Return the current authenticated user (from JWT).
 */
export async function onRequestGet(context) {
  const user = context.data.user;

  if (!user) {
    return Response.json({ user: null });
  }

  return Response.json({
    user: {
      id: user.sub,
      email: user.email,
      name: user.name,
      image: user.image,
    },
  });
}
