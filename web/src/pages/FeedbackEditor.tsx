import { useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';

/**
 * FeedbackEditorPage - Redirects to IssueEditor
 *
 * After consolidating feedback into issues, feedback items are now issues
 * with source='external'. This page redirects to the IssueEditor which
 * handles all issue types uniformly.
 */
export function FeedbackEditorPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();

  useEffect(() => {
    // react-router's navigate() returns `void | Promise<void>`; a rejection here
    // has no established user-facing handling in this codebase and this is a
    // simple redirect, so `void` is the correct fire-and-forget marker (repeated
    // throughout this ticket for the same reason).
    if (id) {
      // Redirect to issue editor - feedback is now just an issue with source='external'
      void navigate(`/documents/${id}`, { replace: true });
    } else {
      void navigate('/issues', { replace: true });
    }
  }, [id, navigate]);

  return null;
}
