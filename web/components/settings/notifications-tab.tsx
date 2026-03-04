'use client';

export function NotificationsTab() {
  return (
    <div className="space-y-6">
      <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">Notifications</h2>

      <div className="space-y-4">
        <label className="flex items-center gap-3">
          <input type="checkbox" defaultChecked className="w-4 h-4 rounded" />
          <span className="text-gray-700 dark:text-gray-300">Agent completion notifications</span>
        </label>
        <label className="flex items-center gap-3">
          <input type="checkbox" defaultChecked className="w-4 h-4 rounded" />
          <span className="text-gray-700 dark:text-gray-300">Permission request notifications</span>
        </label>
        <label className="flex items-center gap-3">
          <input type="checkbox" defaultChecked className="w-4 h-4 rounded" />
          <span className="text-gray-700 dark:text-gray-300">Pipeline approval notifications</span>
        </label>
        <label className="flex items-center gap-3">
          <input type="checkbox" className="w-4 h-4 rounded" />
          <span className="text-gray-700 dark:text-gray-300">Error notifications</span>
        </label>
      </div>
    </div>
  );
}
