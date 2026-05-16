'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Building2,
  Loader2,
  PawPrint,
  Pencil,
  Plus,
  Search,
  Star,
  Trash2,
  User,
  Users,
  X,
} from 'lucide-react';
import { useState } from 'react';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';

// --- Types ---

interface ProfileFact {
  key: string;
  value: string;
  source?: string;
  learnedAt?: string;
}

interface ProfileSummary {
  id: string;
  name: string;
  relationship?: string | null;
  category: string;
  isUserProfile: boolean | null;
  factCount: number;
  updatedAt: string;
}

interface ProfileFull {
  id: string;
  name: string;
  relationship?: string | null;
  category: string;
  isUserProfile: boolean | null;
  facts: ProfileFact[];
  createdAt: string;
  updatedAt: string;
}

interface ToolResult<T = unknown> {
  result: T;
  success: boolean;
}

// --- Constants ---

const CATEGORY_COLORS: Record<string, string> = {
  person: 'bg-blue-900/30 text-primary',
  organization: 'bg-purple-900/30 text-primary',
  pet: 'bg-orange-900/30 text-warning',
};

const CATEGORY_ICONS: Record<string, typeof User> = {
  person: User,
  organization: Building2,
  pet: PawPrint,
};

const RELATIONSHIP_COLORS: Record<string, string> = {
  self: 'bg-primary/20 text-primary',
  mother: 'bg-pink-900/30 text-error',
  father: 'bg-indigo-900/30 text-primary',
  partner: 'bg-red-900/30 text-error',
  friend: 'bg-green-900/30 text-tertiary',
  colleague: 'bg-yellow-900/30 text-warning',
  boss: 'bg-amber-900/30 text-warning',
  sibling: 'bg-teal-900/30 text-tertiary',
};

function getCategoryColor(category: string): string {
  return CATEGORY_COLORS[category] || 'bg-surface-container-high text-on-surface-variant';
}

function getRelationshipColor(relationship: string): string {
  return RELATIONSHIP_COLORS[relationship] || 'bg-surface-container-high text-on-surface-variant';
}

// --- API helpers ---

async function toolExec<T>(toolName: string, params: Record<string, unknown> = {}): Promise<T> {
  const res = await api.post<ToolResult<T>>(`/tools/profiles/tools/${toolName}/execute`, { args: params });
  return res.result;
}

// --- Inline Fact Editor ---

function FactEditor({
  facts,
  profileId,
  onUpdated,
}: {
  facts: ProfileFact[];
  profileId: string;
  onUpdated: () => void;
}) {
  const [newKey, setNewKey] = useState('');
  const [newValue, setNewValue] = useState('');
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [editValue, setEditValue] = useState('');
  const [busy, setBusy] = useState(false);

  const handleAdd = async () => {
    const k = newKey.trim();
    const v = newValue.trim();
    if (!k || !v) return;
    setBusy(true);
    try {
      await toolExec('add_fact', { id: profileId, key: k, value: v });
      setNewKey('');
      setNewValue('');
      onUpdated();
    } catch { /* ignore */ } finally {
      setBusy(false);
    }
  };

  const handleUpdate = async (key: string) => {
    const v = editValue.trim();
    if (!v) return;
    setBusy(true);
    try {
      await toolExec('add_fact', { id: profileId, key, value: v });
      setEditingKey(null);
      onUpdated();
    } catch { /* ignore */ } finally {
      setBusy(false);
    }
  };

  const handleRemove = async (key: string) => {
    setBusy(true);
    try {
      await toolExec('remove_fact', { id: profileId, key });
      onUpdated();
    } catch { /* ignore */ } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-2">
      <div className="text-[10px] uppercase tracking-widest font-bold text-on-surface-variant mb-2">Facts</div>

      {facts.length === 0 && (
        <p className="text-sm text-on-surface-variant italic">No facts yet. Add some below.</p>
      )}

      {facts.map((fact) => (
        <div key={fact.key} className="flex items-center gap-2 bg-surface-container-low rounded-lg px-3 py-2">
          <span className="text-xs font-bold text-on-surface-variant uppercase tracking-wide min-w-[80px]">
            {fact.key}
          </span>
          {editingKey === fact.key ? (
            <>
              <input
                type="text"
                value={editValue}
                onChange={(e) => setEditValue(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleUpdate(fact.key);
                  if (e.key === 'Escape') setEditingKey(null);
                }}
                className="flex-1 bg-surface-container-high border-none rounded-md py-1 px-2 text-on-surface text-sm focus:ring-1 focus:ring-primary"
                autoFocus
                disabled={busy}
              />
              <button
                onClick={() => handleUpdate(fact.key)}
                disabled={busy}
                className="text-primary text-xs font-bold cursor-pointer"
              >
                Save
              </button>
              <button
                onClick={() => setEditingKey(null)}
                className="text-on-surface-variant text-xs cursor-pointer"
              >
                Cancel
              </button>
            </>
          ) : (
            <>
              <span className="flex-1 text-sm text-on-surface">{fact.value}</span>
              <button
                onClick={() => {
                  setEditingKey(fact.key);
                  setEditValue(fact.value);
                }}
                className="p-1 text-on-surface-variant hover:text-primary cursor-pointer"
                title="Edit fact"
              >
                <Pencil className="w-3.5 h-3.5" />
              </button>
              <button
                onClick={() => handleRemove(fact.key)}
                disabled={busy}
                className="p-1 text-on-surface-variant hover:text-error cursor-pointer"
                title="Remove fact"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </>
          )}
        </div>
      ))}

      {/* Add new fact */}
      <div className="flex items-center gap-2 mt-2">
        <input
          type="text"
          value={newKey}
          onChange={(e) => setNewKey(e.target.value)}
          placeholder="Key"
          className="w-[120px] bg-surface-container-high border-none rounded-md py-1.5 px-2 text-on-surface text-sm focus:ring-1 focus:ring-primary"
          disabled={busy}
        />
        <input
          type="text"
          value={newValue}
          onChange={(e) => setNewValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') handleAdd();
          }}
          placeholder="Value"
          className="flex-1 bg-surface-container-high border-none rounded-md py-1.5 px-2 text-on-surface text-sm focus:ring-1 focus:ring-primary"
          disabled={busy}
        />
        <button
          onClick={handleAdd}
          disabled={busy || !newKey.trim() || !newValue.trim()}
          className="px-3 py-1.5 text-xs font-bold bg-primary text-[#0e0e0e] rounded-full disabled:opacity-40 cursor-pointer"
        >
          Add
        </button>
      </div>
    </div>
  );
}

// --- Create Profile Dialog ---

function CreateProfileDialog({
  isUserProfile,
  onClose,
}: {
  isUserProfile: boolean;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [name, setName] = useState('');
  const [relationship, setRelationship] = useState(isUserProfile ? 'self' : '');
  const [category, setCategory] = useState('person');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) {
      setError('Name is required');
      return;
    }
    setError('');
    setSubmitting(true);
    try {
      await toolExec('create_profile', {
        name: name.trim(),
        relationship: relationship || undefined,
        category,
        is_user_profile: isUserProfile,
      });
      queryClient.invalidateQueries({ queryKey: ['profiles'] });
      onClose();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to create profile');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={onClose}>
      <div
        className="bg-surface-container rounded-xl shadow-xl w-full max-w-md mx-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between p-4 border-b border-outline-variant/10">
          <h2 className="text-lg font-semibold text-on-surface">
            {isUserProfile ? 'Set Up Your Profile' : 'Add a Person'}
          </h2>
          <button onClick={onClose} className="text-on-surface-variant hover:text-on-surface cursor-pointer">
            <X className="w-5 h-5" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-4 space-y-4">
          {error && (
            <div className="text-sm text-error bg-red-900/20 rounded-lg px-3 py-2">
              {error}
            </div>
          )}

          <div>
            <label className="block text-sm font-medium text-on-surface/80 mb-1">Name</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={isUserProfile ? 'Your name' : 'Person or entity name'}
              className="w-full bg-surface-container-high border-none rounded-md py-2 px-3 text-on-surface text-sm focus:ring-1 focus:ring-primary"
              autoFocus
            />
          </div>

          {!isUserProfile && (
            <>
              <div>
                <label className="block text-sm font-medium text-on-surface/80 mb-1">Relationship</label>
                <input
                  type="text"
                  value={relationship}
                  onChange={(e) => setRelationship(e.target.value)}
                  placeholder="e.g., friend, colleague, mother"
                  className="w-full bg-surface-container-high border-none rounded-md py-2 px-3 text-on-surface text-sm focus:ring-1 focus:ring-primary"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-on-surface/80 mb-1">Category</label>
                <select
                  value={category}
                  onChange={(e) => setCategory(e.target.value)}
                  className="w-full bg-surface-container-high border-none rounded-md py-2 px-3 text-on-surface text-sm focus:ring-1 focus:ring-primary"
                >
                  <option value="person">Person</option>
                  <option value="organization">Organization</option>
                  <option value="pet">Pet</option>
                </select>
              </div>
            </>
          )}

          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-sm text-on-surface/80 bg-surface-container-high rounded-lg hover:bg-surface-container-high cursor-pointer"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting}
              className="px-4 py-2 text-sm bg-primary text-[#0e0e0e] rounded-full font-bold disabled:opacity-50 cursor-pointer"
            >
              {submitting ? 'Creating...' : isUserProfile ? 'Create My Profile' : 'Add Person'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// --- Edit Profile Dialog (expanded view) ---

function EditProfileDialog({
  profileId,
  onClose,
}: {
  profileId: string;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [error, setError] = useState('');
  const [deleting, setDeleting] = useState(false);
  const [editingFields, setEditingFields] = useState(false);
  const [name, setName] = useState('');
  const [relationship, setRelationship] = useState('');
  const [category, setCategory] = useState('');
  const [saving, setSaving] = useState(false);

  const { data, isLoading, refetch } = useQuery({
    queryKey: ['profile', profileId],
    queryFn: async () => {
      const res = await toolExec<ProfileFull>('get_profile', { id: profileId });
      return res;
    },
  });

  const profile = data;

  const startEdit = () => {
    if (!profile) return;
    setName(profile.name);
    setRelationship(profile.relationship || '');
    setCategory(profile.category);
    setEditingFields(true);
  };

  const handleSaveFields = async () => {
    if (!profile) return;
    setSaving(true);
    setError('');
    try {
      const updates: Record<string, unknown> = {};
      if (name.trim() && name.trim() !== profile.name) updates.name = name.trim();
      if (relationship !== (profile.relationship || '')) updates.relationship = relationship;
      if (category !== profile.category) updates.category = category;

      if (Object.keys(updates).length > 0) {
        await toolExec('update_profile', { id: profileId, ...updates });
      }
      setEditingFields(false);
      refetch();
      queryClient.invalidateQueries({ queryKey: ['profiles'] });
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to update profile');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!confirm('Are you sure you want to delete this profile? This cannot be undone.')) return;
    setDeleting(true);
    setError('');
    try {
      await toolExec('delete_profile', { id: profileId });
      queryClient.invalidateQueries({ queryKey: ['profiles'] });
      onClose();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to delete profile');
    } finally {
      setDeleting(false);
    }
  };

  if (isLoading) {
    return (
      <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={onClose}>
        <div className="bg-surface-container rounded-xl shadow-xl w-full max-w-2xl mx-4 p-8 text-center" onClick={(e) => e.stopPropagation()}>
          <Loader2 className="w-5 h-5 animate-spin inline mr-2 text-on-surface-variant" />
          <span className="text-on-surface-variant">Loading profile...</span>
        </div>
      </div>
    );
  }

  if (!profile) {
    return (
      <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={onClose}>
        <div className="bg-surface-container rounded-xl shadow-xl w-full max-w-md mx-4 p-6 text-center" onClick={(e) => e.stopPropagation()}>
          <p className="text-on-surface-variant">Profile not found.</p>
          <button onClick={onClose} className="mt-4 px-4 py-2 text-sm bg-surface-container-high text-on-surface/80 rounded-lg cursor-pointer">
            Close
          </button>
        </div>
      </div>
    );
  }

  const CategoryIcon = CATEGORY_ICONS[profile.category] || User;

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={onClose}>
      <div
        className="bg-surface-container rounded-xl shadow-xl w-full max-w-2xl mx-4 max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-outline-variant/10">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-full bg-surface-container-high flex items-center justify-center">
              <CategoryIcon className="w-5 h-5 text-primary" />
            </div>
            <div>
              {editingFields ? (
                <input
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className="bg-surface-container-high border-none rounded-md py-1 px-2 text-on-surface text-lg font-semibold focus:ring-1 focus:ring-primary"
                  autoFocus
                />
              ) : (
                <h2 className="text-lg font-semibold text-on-surface">{profile.name}</h2>
              )}
              <div className="flex items-center gap-2 mt-0.5">
                {profile.isUserProfile && (
                  <span className="px-2 py-0.5 text-xs rounded-full bg-primary/20 text-primary font-medium flex items-center gap-1">
                    <Star className="w-3 h-3" /> You
                  </span>
                )}
                {profile.relationship && !editingFields && (
                  <span className={cn('px-2 py-0.5 text-xs rounded-full font-medium', getRelationshipColor(profile.relationship))}>
                    {profile.relationship}
                  </span>
                )}
                {!editingFields && (
                  <span className={cn('px-2 py-0.5 text-xs rounded-full font-medium', getCategoryColor(profile.category))}>
                    {profile.category}
                  </span>
                )}
              </div>
            </div>
          </div>

          <div className="flex items-center gap-2">
            {!editingFields ? (
              <button
                onClick={startEdit}
                className="p-2 text-on-surface-variant hover:text-primary cursor-pointer"
                title="Edit profile fields"
              >
                <Pencil className="w-4 h-4" />
              </button>
            ) : (
              <div className="flex items-center gap-1">
                <button
                  onClick={handleSaveFields}
                  disabled={saving}
                  className="px-3 py-1.5 text-xs font-bold bg-primary text-[#0e0e0e] rounded-full cursor-pointer disabled:opacity-50"
                >
                  {saving ? 'Saving...' : 'Save'}
                </button>
                <button
                  onClick={() => setEditingFields(false)}
                  className="px-3 py-1.5 text-xs text-on-surface-variant cursor-pointer"
                >
                  Cancel
                </button>
              </div>
            )}
            {!profile.isUserProfile && (
              <button
                onClick={handleDelete}
                disabled={deleting}
                className="p-2 text-on-surface-variant hover:text-error cursor-pointer"
                title="Delete profile"
              >
                <Trash2 className="w-4 h-4" />
              </button>
            )}
            <button onClick={onClose} className="text-on-surface-variant hover:text-on-surface cursor-pointer">
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Editing fields */}
        {editingFields && (
          <div className="p-4 border-b border-outline-variant/10 flex gap-4">
            <div className="flex-1">
              <label className="block text-xs font-medium text-on-surface-variant mb-1">Relationship</label>
              <input
                type="text"
                value={relationship}
                onChange={(e) => setRelationship(e.target.value)}
                placeholder="e.g., friend, colleague"
                className="w-full bg-surface-container-high border-none rounded-md py-1.5 px-2 text-on-surface text-sm focus:ring-1 focus:ring-primary"
              />
            </div>
            <div className="flex-1">
              <label className="block text-xs font-medium text-on-surface-variant mb-1">Category</label>
              <select
                value={category}
                onChange={(e) => setCategory(e.target.value)}
                className="w-full bg-surface-container-high border-none rounded-md py-1.5 px-2 text-on-surface text-sm focus:ring-1 focus:ring-primary"
              >
                <option value="person">Person</option>
                <option value="organization">Organization</option>
                <option value="pet">Pet</option>
              </select>
            </div>
          </div>
        )}

        {/* Error */}
        {error && (
          <div className="mx-4 mt-4 text-sm text-error bg-red-900/20 rounded-lg px-3 py-2">
            {error}
          </div>
        )}

        {/* Facts */}
        <div className="p-4">
          <FactEditor
            facts={profile.facts}
            profileId={profile.id}
            onUpdated={() => {
              refetch();
              queryClient.invalidateQueries({ queryKey: ['profiles'] });
            }}
          />
        </div>
      </div>
    </div>
  );
}

// --- User Profile Card ---

function UserProfileCard({
  profile,
  onClick,
}: {
  profile: ProfileSummary | null;
  onClick: () => void;
}) {
  if (!profile) {
    return (
      <button
        onClick={onClick}
        className="w-full bg-surface-container rounded-xs p-6 border border-dashed border-outline-variant/20 hover:border-primary/40 transition-colors text-left cursor-pointer"
      >
        <div className="flex items-center gap-4">
          <div className="w-12 h-12 rounded-full bg-surface-container-high flex items-center justify-center">
            <User className="w-6 h-6 text-on-surface-variant" />
          </div>
          <div>
            <h3 className="text-on-surface font-semibold">Set up your profile</h3>
            <p className="text-sm text-on-surface-variant mt-0.5">
              Create your profile so agents can personalize responses for you.
            </p>
          </div>
          <Plus className="w-5 h-5 text-on-surface-variant ml-auto" />
        </div>
      </button>
    );
  }

  return (
    <button
      onClick={onClick}
      className="w-full bg-surface-container rounded-xs p-6 border border-outline-variant/10 hover:border-primary/30 transition-colors text-left cursor-pointer"
    >
      <div className="flex items-center gap-4">
        <div className="w-12 h-12 rounded-full bg-primary/10 flex items-center justify-center">
          <Star className="w-6 h-6 text-primary" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <h3 className="text-on-surface font-semibold">{profile.name}</h3>
            <span className="px-2 py-0.5 text-xs rounded-full bg-primary/20 text-primary font-medium">
              Your Profile
            </span>
          </div>
          <p className="text-sm text-on-surface-variant mt-0.5">
            {profile.factCount} fact{profile.factCount !== 1 ? 's' : ''} stored
          </p>
        </div>
        <Pencil className="w-4 h-4 text-on-surface-variant" />
      </div>
    </button>
  );
}

// --- People Card ---

function PersonCard({
  profile,
  onClick,
}: {
  profile: ProfileSummary;
  onClick: () => void;
}) {
  const CategoryIcon = CATEGORY_ICONS[profile.category] || User;

  return (
    <button
      onClick={onClick}
      className="w-full bg-surface-container rounded-xs p-5 border border-outline-variant/10 hover:border-primary/30 transition-colors text-left cursor-pointer"
    >
      <div className="flex items-start gap-3">
        <div className="w-10 h-10 rounded-full bg-surface-container-high flex items-center justify-center shrink-0">
          <CategoryIcon className="w-5 h-5 text-primary" />
        </div>
        <div className="flex-1 min-w-0">
          <h3 className="text-on-surface font-medium truncate">{profile.name}</h3>
          <div className="flex items-center gap-1.5 mt-1.5 flex-wrap">
            {profile.relationship && (
              <span className={cn('px-2 py-0.5 text-[10px] rounded-full font-medium', getRelationshipColor(profile.relationship))}>
                {profile.relationship}
              </span>
            )}
            <span className={cn('px-2 py-0.5 text-[10px] rounded-full font-medium', getCategoryColor(profile.category))}>
              {profile.category}
            </span>
          </div>
          <p className="text-xs text-on-surface-variant mt-2">
            {profile.factCount} fact{profile.factCount !== 1 ? 's' : ''}
          </p>
        </div>
      </div>
    </button>
  );
}

// --- Empty State ---

function EmptyState({
  onSetupProfile,
  onAddPerson,
}: {
  onSetupProfile: () => void;
  onAddPerson: () => void;
}) {
  return (
    <div className="bg-surface-container rounded-xs border border-outline-variant/10 p-12 text-center">
      <Users className="w-10 h-10 text-on-surface-variant mx-auto mb-4" />
      <p className="text-on-surface-variant max-w-md mx-auto">
        No profiles yet. Create your own profile to get personalized responses, or add people you interact with regularly.
      </p>
      <div className="flex items-center justify-center gap-3 mt-6">
        <button
          onClick={onSetupProfile}
          className="px-5 py-2.5 text-sm bg-primary text-[#0e0e0e] rounded-full font-bold cursor-pointer"
        >
          Set Up My Profile
        </button>
        <button
          onClick={onAddPerson}
          className="px-5 py-2.5 text-sm bg-surface-container-high text-on-surface rounded-full font-bold hover:bg-surface-container-high cursor-pointer"
        >
          Add a Person
        </button>
      </div>
    </div>
  );
}

// --- Main Page ---

export default function ProfilesPage() {
  const [searchQuery, setSearchQuery] = useState('');
  const [showCreateUser, setShowCreateUser] = useState(false);
  const [showCreatePerson, setShowCreatePerson] = useState(false);
  const [selectedProfileId, setSelectedProfileId] = useState<string | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ['profiles'],
    queryFn: async () => {
      try {
        return await toolExec<{ profiles: ProfileSummary[]; message?: string }>('list_profiles');
      } catch {
        return { profiles: [] };
      }
    },
  });

  const profiles = data?.profiles || [];
  const userProfile = profiles.find((p) => p.isUserProfile);
  const otherProfiles = profiles.filter((p) => !p.isUserProfile);

  const filtered = otherProfiles.filter((p) => {
    if (!searchQuery) return true;
    const q = searchQuery.toLowerCase();
    return (
      p.name.toLowerCase().includes(q) ||
      (p.relationship || '').toLowerCase().includes(q) ||
      p.category.toLowerCase().includes(q)
    );
  });

  const hasAnyProfiles = profiles.length > 0;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-xl text-on-surface">People & Profiles</h1>
        <p className="text-on-surface-variant mt-2">
          Store information about people, organizations, and relationships. Your own profile is automatically shared with agents for personalized responses.
        </p>
      </div>

      {isLoading ? (
        <div className="bg-surface-container rounded-xs border border-outline-variant/10 p-8 text-center text-on-surface-variant">
          <Loader2 className="w-5 h-5 animate-spin inline mr-2" />
          Loading profiles...
        </div>
      ) : !hasAnyProfiles ? (
        <EmptyState
          onSetupProfile={() => setShowCreateUser(true)}
          onAddPerson={() => setShowCreatePerson(true)}
        />
      ) : (
        <>
          {/* Your Profile */}
          <div>
            <div className="text-[10px] uppercase tracking-widest font-bold text-on-surface-variant mb-3">
              Your Profile
            </div>
            <UserProfileCard
              profile={userProfile || null}
              onClick={() => {
                if (userProfile) {
                  setSelectedProfileId(userProfile.id);
                } else {
                  setShowCreateUser(true);
                }
              }}
            />
          </div>

          {/* People List */}
          <div>
            <div className="flex items-center justify-between mb-3">
              <div className="text-[10px] uppercase tracking-widest font-bold text-on-surface-variant">
                People ({otherProfiles.length})
              </div>
              <button
                onClick={() => setShowCreatePerson(true)}
                className="flex items-center gap-1.5 px-4 py-2 text-sm bg-primary text-[#0e0e0e] rounded-full font-bold cursor-pointer"
              >
                <Plus className="w-4 h-4" />
                Add Person
              </button>
            </div>

            {/* Search */}
            {otherProfiles.length > 0 && (
              <div className="relative mb-4">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-on-surface-variant" />
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Search people by name, relationship, or category..."
                  className="w-full pl-10 pr-4 py-2 bg-surface-container border border-outline-variant/10 rounded-lg text-sm focus:ring-2 focus:ring-primary text-on-surface"
                />
              </div>
            )}

            {/* Grid */}
            {filtered.length === 0 && otherProfiles.length > 0 ? (
              <div className="bg-surface-container rounded-xs border border-outline-variant/10 p-8 text-center">
                <Search className="w-6 h-6 text-on-surface-variant mx-auto mb-2" />
                <p className="text-on-surface-variant text-sm">No profiles match your search.</p>
              </div>
            ) : filtered.length === 0 ? (
              <div className="bg-surface-container rounded-xs border border-outline-variant/10 p-8 text-center">
                <Users className="w-6 h-6 text-on-surface-variant mx-auto mb-2" />
                <p className="text-on-surface-variant text-sm">
                  No people added yet. Click &quot;Add Person&quot; to get started.
                </p>
              </div>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                {filtered.map((profile) => (
                  <PersonCard
                    key={profile.id}
                    profile={profile}
                    onClick={() => setSelectedProfileId(profile.id)}
                  />
                ))}
              </div>
            )}
          </div>
        </>
      )}

      {/* Dialogs */}
      {showCreateUser && (
        <CreateProfileDialog
          isUserProfile={true}
          onClose={() => setShowCreateUser(false)}
        />
      )}
      {showCreatePerson && (
        <CreateProfileDialog
          isUserProfile={false}
          onClose={() => setShowCreatePerson(false)}
        />
      )}
      {selectedProfileId && (
        <EditProfileDialog
          profileId={selectedProfileId}
          onClose={() => setSelectedProfileId(null)}
        />
      )}
    </div>
  );
}
