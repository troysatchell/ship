import { useEffect } from 'react';
import { isThrottleError, subscribeToMutationErrors } from '@/lib/queryClient';
import { useToast } from '@/components/ui/Toast';

/**
 * Subscribes to global mutation errors and displays toast notifications.
 * Place this component inside ToastProvider.
 */
export function MutationErrorToast() {
  const { showToast } = useToast();

  useEffect(() => {
    const unsubscribe = subscribeToMutationErrors((error, context) => {
      const summary = context.operation
        ? `Failed to ${context.operation}`
        : error.message || 'Something went wrong';

      // A throttled write (HTTP 429) reaching here has already exhausted its
      // backoff retries, so the change is genuinely lost. Say so, and keep the
      // toast on screen until it is acknowledged instead of dropping it after
      // three seconds - a silent drop is the defect this fixes (TRO-172).
      if (isThrottleError(error)) {
        showToast(
          `${summary}: the server is rate limiting requests and your change was not saved. Please try again.`,
          'error',
          0
        );
        return;
      }

      showToast(summary, 'error');
    });

    return unsubscribe;
  }, [showToast]);

  return null;
}
