import { Router } from 'express';
import type { Router as RouterType } from 'express';
import { z } from 'zod';
import { authMiddleware, authed, workspaceAdminMiddleware } from '../middleware/auth.js';
import { ERROR_CODES, HTTP_STATUS } from '@ship/shared';
import {
  createOAuthApp,
  listOAuthApps,
  getOAuthApp,
  rotateOAuthAppSecret,
  revokeOAuthApp,
} from '../platform/oauth/appRegistration.js';

/**
 * Internal admin endpoint for OAuth app registration (PF-102, TRO-408).
 *
 * NOT `/api/v1` — this is a session-authed internal `/api` surface (like
 * `api-tokens.ts`), registered in the *existing* internal OpenAPI registry
 * (`api/src/openapi/schemas/oauth-apps.ts`), not the v1 platform registry.
 * `oauth_apps` rows created here are what PF-103/PF-104/PF-107's public OAuth
 * flows authenticate against later.
 *
 * Deliberately thin: every DB read/write lives in
 * `api/src/platform/oauth/appRegistration.ts` (the ticket's stated module
 * home) — this file only validates the request and maps a result to a
 * response.
 *
 * Gated by `workspaceAdminMiddleware`, mirroring `workspaces.ts`'s
 * member-management routes: registering an app that can act on behalf of the
 * workspace is a workspace-admin action, not something any member does (the
 * looser bar `api-tokens.ts` uses for a user's own personal token).
 */
const router: RouterType = Router();

router.use(authMiddleware, workspaceAdminMiddleware);

const createAppSchema = z.object({
  name: z.string().min(1).max(200),
  client_type: z.enum(['confidential', 'public']),
  redirect_uris: z.array(z.string().url()).max(20).optional(),
  requested_scopes: z.array(z.string().min(1)).max(50).optional(),
});

// POST /api/oauth-apps - Register a new OAuth app (AC-1, AC-2)
router.post('/', authed(async (req, res): Promise<void> => {
  const parseResult = createAppSchema.safeParse(req.body);

  if (!parseResult.success) {
    res.status(HTTP_STATUS.BAD_REQUEST).json({
      success: false,
      error: {
        code: ERROR_CODES.VALIDATION_ERROR,
        message: 'Invalid request',
        details: parseResult.error.flatten(),
      },
    });
    return;
  }

  const { name, client_type, redirect_uris, requested_scopes } = parseResult.data;

  try {
    const { app, clientSecret } = await createOAuthApp({
      workspaceId: req.workspaceId,
      ownerUserId: req.userId,
      name,
      clientType: client_type,
      redirectUris: redirect_uris,
      requestedScopes: requested_scopes,
    });

    // No log line anywhere in this handler's success path. `clientSecret`
    // exists only in this local variable and in the one response body below
    // — AC-2 (raw secret absent from logs).
    res.status(HTTP_STATUS.CREATED).json({
      success: true,
      data: {
        id: app.id,
        client_id: app.client_id,
        client_secret: clientSecret, // shown exactly once — never stored, never returned again (AC-1, AC-3)
        name: app.name,
        client_type: app.client_type,
        redirect_uris: app.redirect_uris,
        requested_scopes: app.requested_scopes,
        created_at: app.created_at,
        warning: clientSecret
          ? 'Save this secret now. It will not be shown again.'
          : undefined,
      },
    });
  } catch (error) {
    // Logs the error only — never req.body or the response payload, which is
    // the one place the raw secret exists outside this function (AC-2).
    console.error('Create OAuth app error:', error instanceof Error ? error.message : error);
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({
      success: false,
      error: { code: ERROR_CODES.INTERNAL_ERROR, message: 'Failed to register OAuth app' },
    });
  }
}));

// GET /api/oauth-apps - List this workspace's OAuth apps (never includes a secret)
router.get('/', authed(async (req, res): Promise<void> => {
  try {
    const apps = await listOAuthApps(req.workspaceId);
    res.json({ success: true, data: apps });
  } catch (error) {
    console.error('List OAuth apps error:', error instanceof Error ? error.message : error);
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({
      success: false,
      error: { code: ERROR_CODES.INTERNAL_ERROR, message: 'Failed to list OAuth apps' },
    });
  }
}));

// GET /api/oauth-apps/:id - App detail (never includes a secret) (AC-3)
router.get('/:id', authed(async (req, res): Promise<void> => {
  const id = String(req.params.id);

  try {
    const app = await getOAuthApp(id, req.workspaceId);

    if (!app) {
      res.status(HTTP_STATUS.NOT_FOUND).json({
        success: false,
        error: { code: ERROR_CODES.NOT_FOUND, message: 'OAuth app not found' },
      });
      return;
    }

    res.json({ success: true, data: app });
  } catch (error) {
    console.error('Get OAuth app error:', error instanceof Error ? error.message : error);
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({
      success: false,
      error: { code: ERROR_CODES.INTERNAL_ERROR, message: 'Failed to fetch OAuth app' },
    });
  }
}));

// POST /api/oauth-apps/:id/rotate - Rotate the client secret (confidential apps only) (AC-4)
router.post('/:id/rotate', authed(async (req, res): Promise<void> => {
  const id = String(req.params.id);

  try {
    const result = await rotateOAuthAppSecret({ appId: id, workspaceId: req.workspaceId });

    if (!result.ok) {
      if (result.error === 'not_found') {
        res.status(HTTP_STATUS.NOT_FOUND).json({
          success: false,
          error: { code: ERROR_CODES.NOT_FOUND, message: 'OAuth app not found' },
        });
        return;
      }

      if (result.error === 'revoked') {
        res.status(HTTP_STATUS.BAD_REQUEST).json({
          success: false,
          error: {
            code: ERROR_CODES.VALIDATION_ERROR,
            message: 'Cannot rotate the secret of a revoked OAuth app.',
          },
        });
        return;
      }

      // result.error === 'public_client_no_secret' — PM triage: 400 with a
      // clear message, not a 404 and not a silently-minted secret.
      res.status(HTTP_STATUS.BAD_REQUEST).json({
        success: false,
        error: {
          code: ERROR_CODES.VALIDATION_ERROR,
          message:
            'Public OAuth apps have no client secret to rotate — they authenticate with PKCE, not a secret.',
        },
      });
      return;
    }

    // Same AC-2 reasoning as creation: no log line on this path.
    res.json({
      success: true,
      data: {
        client_secret: result.clientSecret, // shown exactly once (AC-1/AC-3 apply equally to rotation)
        warning:
          'Save this secret now. It will not be shown again. The previous secret is invalid immediately — there is no grace period.',
      },
    });
  } catch (error) {
    console.error('Rotate OAuth app secret error:', error instanceof Error ? error.message : error);
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({
      success: false,
      error: { code: ERROR_CODES.INTERNAL_ERROR, message: 'Failed to rotate OAuth app secret' },
    });
  }
}));

// DELETE /api/oauth-apps/:id - Revoke an OAuth app (AC-5)
router.delete('/:id', authed(async (req, res): Promise<void> => {
  const id = String(req.params.id);

  try {
    const result = await revokeOAuthApp({ appId: id, workspaceId: req.workspaceId });

    if (!result.ok) {
      if (result.error === 'not_found') {
        res.status(HTTP_STATUS.NOT_FOUND).json({
          success: false,
          error: { code: ERROR_CODES.NOT_FOUND, message: 'OAuth app not found' },
        });
        return;
      }

      res.status(HTTP_STATUS.CONFLICT).json({
        success: false,
        error: { code: ERROR_CODES.ALREADY_EXISTS, message: 'OAuth app is already revoked.' },
      });
      return;
    }

    res.json({ success: true, data: { message: 'OAuth app revoked' } });
  } catch (error) {
    console.error('Revoke OAuth app error:', error instanceof Error ? error.message : error);
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({
      success: false,
      error: { code: ERROR_CODES.INTERNAL_ERROR, message: 'Failed to revoke OAuth app' },
    });
  }
}));

export default router;
