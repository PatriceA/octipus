'use client';

export function NotificationsTab() {
  return (
    <div className="space-y-6">
      <h2 className="text-lg font-extrabold tracking-tighter text-white">Notifications</h2>

      <div className="space-y-4">
        <label className="flex items-center gap-3">
          <input type="checkbox" defaultChecked className="w-4 h-4 rounded accent-primary" />
          <span className="text-white">Agent completion notifications</span>
        </label>
        <label className="flex items-center gap-3">
          <input type="checkbox" defaultChecked className="w-4 h-4 rounded accent-primary" />
          <span className="text-white">Permission request notifications</span>
        </label>
        <label className="flex items-center gap-3">
          <input type="checkbox" defaultChecked className="w-4 h-4 rounded accent-primary" />
          <span className="text-white">Pipeline approval notifications</span>
        </label>
        <label className="flex items-center gap-3">
          <input type="checkbox" className="w-4 h-4 rounded accent-primary" />
          <span className="text-white">Error notifications</span>
        </label>
      </div>
    </div>
  );
}
