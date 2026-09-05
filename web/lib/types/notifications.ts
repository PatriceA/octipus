/** A row of the `notifications` table as the API returns it. */
export interface Notification {
  id: string;
  type: string;
  title: string;
  body?: string | null;
  metadata?: Record<string, unknown> | null;
  read: boolean;
  createdAt: string;
}
