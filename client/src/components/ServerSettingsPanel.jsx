import { Suspense, lazy, useEffect, useMemo, useRef, useState } from 'react';
import {
  Camera,
  Check,
  Copy,
  Crown,
  GripVertical,
  Loader2,
  LogOut,
  Plus,
  RefreshCw,
  Save,
  ShieldCheck,
  Trash2,
  UserMinus,
  X
} from 'lucide-react';
import Avatar from './Avatar';
import ServerIcon from './ServerIcon';
import ServerIconCropModal from './ServerIconCropModal';
import ServerIconSuggestions from './ServerIconSuggestions';
import AutomodSettings from './AutomodSettings';
import ChannelManager from './ChannelManager';
import ServerDataSettings from './ServerDataSettings';
import ServerEmotes from './ServerEmotes';
import api from '../api';
import InsightsCard from './InsightsCard';
import { assetUrl } from '../runtime';
import { AVATAR_COLORS, DISCOVER_CATEGORIES, formatDate, inviteLink } from '../utils';
import {
  DEFAULT_MEMBER_PERMISSIONS,
  PERMISSION_GROUPS,
  PERMISSION_META,
  SERVER_PERMISSIONS,
  canManageGroup,
  canManageMember,
  canManageMemberGroups,
  groupMemberCount,
  hasServerPermission,
  highestPosition,
  isOwnerOrAdmin,
  permissionCount,
  visibleGroups
} from '../permissions';

// Invite management is a rarely-opened modal, so it stays out of the settings
// panel's chunk and only downloads when someone asks for it.
const InviteManager = lazy(() => import('./InviteManager'));
// The tiers shop is a settings screen a member opens occasionally, not a hot
// path, so it stays out of the settings chunk until someone asks for it.
const ServerTiersPanel = lazy(() => import('./ServerTiersPanel'));

const TABS = [
  { id: 'overview', label: 'Overview' },
  { id: 'channels', label: 'Channels' },
  { id: 'emotes', label: 'Emotes' },
  { id: 'groups', label: 'Groups' },
  { id: 'tiers', label: 'Subscriptions' },
  { id: 'members', label: 'Members' },
  { id: 'automod', label: 'Automod' },
  { id: 'data', label: 'Data' }
];

function permissionGroups() {
  return PERMISSION_GROUPS.map((name) => ({
    name,
    permissions: PERMISSION_META.filter((permission) => permission.group === name)
  }));
}

export default function ServerSettingsPanel({
  server,
  me,
  presence,
  socket,
  onUpdated,
  onRemoved,
  // Set when the panel is opened from somewhere that points at a card (the
  // onboarding checklist). The matching element carries data-settings-focus.
  focus = ''
}) {
  const [tab, setTab] = useState('overview');
  const [name, setName] = useState(server.name);
  const [description, setDescription] = useState(server.description || '');
  const [iconColor, setIconColor] = useState(server.iconColor);
  const [iconUrl, setIconUrl] = useState(server.iconUrl || '');
  const [bannerUrl, setBannerUrl] = useState(server.banner || '');
  // The boost count is server-wide, but "have I boosted this" is viewer-scoped
  // and a broadcast rebuild is viewer-neutral, so the card asks the API on
  // open. The button stays disabled until that answer lands.
  const [myBoost, setMyBoost] = useState(
    typeof server.boosted === 'boolean' ? server.boosted : null
  );
  const [boostStatusLoaded, setBoostStatusLoaded] = useState(false);
  const [boostStatusError, setBoostStatusError] = useState('');
  const [boostAttempt, setBoostAttempt] = useState(0);
  const [cropFile, setCropFile] = useState(null);
  const [iconHistory, setIconHistory] = useState([]);
  const [inviteCode, setInviteCode] = useState(server.inviteCode);
  // The draft is separate from the saved code so a rejected name does not
  // overwrite the working link in the box above it.
  const [codeDraft, setCodeDraft] = useState(server.inviteCode);
  const [codeSaved, setCodeSaved] = useState(false);
  const inviteUrl = inviteLink(inviteCode);
  // Server-computed, so the rule and its numbers live in one place. Absent on
  // an older payload, in which case the field stays enabled and the API decides.
  const inviteVanity = server.inviteVanity || null;
  const [showInvites, setShowInvites] = useState(false);
  const [busy, setBusy] = useState('');
  const [error, setErrorState] = useState('');
  const [copied, setCopied] = useState(false);
  const [selectedGroupId, setSelectedGroupId] = useState(null);
  const [creatingGroup, setCreatingGroup] = useState(false);
  const [groupDraft, setGroupDraft] = useState(null);
  const [categoryDraft, setCategoryDraft] = useState('');
  const [categoryDraftColor, setCategoryDraftColor] = useState(AVATAR_COLORS[0] || '#6d5efc');
  const [categoryPresetsOpen, setCategoryPresetsOpen] = useState(false);
  const [editingMemberId, setEditingMemberId] = useState(null);
  const [memberGroupDraft, setMemberGroupDraft] = useState([]);
  const [draggingGroupId, setDraggingGroupId] = useState(null);
  const [dragOverGroup, setDragOverGroup] = useState(null);
  // The welcome body is not in buildServer (it can be 1000 characters), so the
  // card loads the full record once and keeps it as a draft until Save.
  const [welcomeEnabled, setWelcomeEnabled] = useState(!!server.welcomeEnabled);
  const [welcomeChannelId, setWelcomeChannelId] = useState('');
  const [welcomeTitle, setWelcomeTitle] = useState('');
  const [welcomeBody, setWelcomeBody] = useState('');
  // House rules travel as one textarea and are stored one per line, so the
  // draft is the joined string and only the save splits it.
  const [welcomeRules, setWelcomeRules] = useState('');
  const [welcomeLoaded, setWelcomeLoaded] = useState(false);
  const [welcomeError, setWelcomeError] = useState('');
  const [welcomeAttempt, setWelcomeAttempt] = useState(0);
  const [welcomeSaved, setWelcomeSaved] = useState(false);
  const welcomeRuleLines = welcomeRules
    .split('\n')
    .map((rule) => rule.trim())
    .filter(Boolean);
  // Join and leave lines are a plain server switch, so there is nothing to load
  // lazily: the value arrives with buildServer.
  const [joinMessages, setJoinMessages] = useState(server.joinMessages !== false);
  const [joinSaved, setJoinSaved] = useState(false);
  // Save feedback belongs next to the card that failed, not in one banner at
  // the top of a long scrolling panel. The scope says which card owns it.
  const [errorScope, setErrorScope] = useState('');
  const welcomeSavedTimer = useRef(null);
  const joinSavedTimer = useRef(null);
  const copiedTimer = useRef(null);
  const codeSavedTimer = useRef(null);
  const panelRef = useRef(null);

  function setError(message, scope = '') {
    setErrorScope(scope);
    setErrorState(message);
  }

  const groups = server.groups || [];
  const groupCategories = server.groupCategories || [];
  // The roles list is rendered by category, in category order, with uncategorised
  // groups last. A category with nothing in it is skipped: an empty heading is
  // noise in a list you are trying to scan.
  const groupSections = useMemo(() => {
    const sections = [];
    for (const category of groupCategories) {
      const owned = groups.filter((group) => group.categoryId === category.id);
      if (owned.length) sections.push({ key: 'cat-' + category.id, name: category.name, groups: owned });
    }
    const loose = groups.filter((group) => !group.categoryId);
    if (loose.length) {
      sections.push({ key: 'loose', name: sections.length ? 'No category' : '', groups: loose });
    }
    return sections;
  }, [groups, groupCategories]);
  const defaultGroupName = groups.find((group) => group.isDefault)?.name || 'Members';
  const membership = server.members.find((member) => member.id === me.id);
  const isMember = !!membership;
  const isOwner = membership?.serverRole === 'owner';
  const ownerOrAdmin = isOwnerOrAdmin(server, me);
  const canReorderGroups = ownerOrAdmin;
  const canManageServer = hasServerPermission(server, me, 'manageServer');
  // The server answers this in buildServer; when the field is missing (an older
  // payload) the API is still the gate, so the input stays available.
  const canEditCode = canManageServer && (!inviteVanity || inviteVanity.allowed);
  const canManageChannels = hasServerPermission(server, me, 'manageChannels');
  const canManageGroups = hasServerPermission(server, me, 'manageGroups');
  const canKick = hasServerPermission(server, me, 'kickMembers');
  const canImportData = ownerOrAdmin;
  const visibleTabs = TABS.filter((entry) => {
    if (entry.id === 'channels') return canManageChannels;
    if (entry.id === 'data') return canManageServer || canImportData;
    return true;
  });
  const textChannels = (server.channels || []).filter((channel) => channel.type === 'text');
  const welcomeChannelName = textChannels.find(
    (channel) => String(channel.id) === String(welcomeChannelId)
  )?.name;
  const selectedGroup = groups.find((group) => group.id === selectedGroupId) || null;
  const canEditSelected =
    creatingGroup || (selectedGroup && canManageGroup(server, me, selectedGroup));
  const canEditDefault = ownerOrAdmin;
  const boostCount = Number(server.boostCount) || 0;
  const boostLevel = Number(server.boostLevel) || 0;
  // Same thresholds the server uses: 2 boosts is level 1, 7 is level 2, 14 is
  // level 3. The bar fills toward the next threshold.
  const nextBoostTier = [2, 7, 14].find((tier) => boostCount < tier) || 0;
  const boostProgress = nextBoostTier
    ? Math.min(100, Math.round((boostCount / nextBoostTier) * 100))
    : 100;

  // Only a different server re-seeds the drafts. A server:updated broadcast
  // hands us a new object identity with the same id, and re-seeding on that
  // would throw away unsaved edits and close the crop modal mid-upload.
  // Saves re-seed explicitly from their own response below.
  useEffect(() => {
    setInviteCode(server.inviteCode);
    setCodeDraft(server.inviteCode);
    setName(server.name);
    setDescription(server.description || '');
    setIconColor(server.iconColor);
    setIconUrl(server.iconUrl || '');
    setBannerUrl(server.banner || '');
    setMyBoost(typeof server.boosted === 'boolean' ? server.boosted : null);
    setCropFile(null);
    setError('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [server.id]);

  // The viewer-scoped flag is not in a viewer-neutral broadcast payload, so it
  // is fetched here alongside the welcome record. Locking the button until the
  // answer arrives keeps an existing booster from being offered "Boost".
  useEffect(() => {
    if (!isMember) {
      setBoostStatusLoaded(false);
      setBoostStatusError('');
      return undefined;
    }
    let cancelled = false;
    setBoostStatusLoaded(false);
    setBoostStatusError('');
    api
      .get(`/api/servers/${server.id}/boost/me`)
      .then((payload) => {
        if (cancelled) return;
        setMyBoost(!!payload.boosted);
        setBoostStatusLoaded(true);
      })
      .catch((err) => {
        if (cancelled) return;
        setBoostStatusLoaded(false);
        setBoostStatusError(err?.message || 'Could not load your boost status.');
      });
    return () => {
      cancelled = true;
    };
  }, [server.id, isMember, boostAttempt]);

  useEffect(() => {
    if (!canManageServer) {
      setIconHistory([]);
      return undefined;
    }
    let cancelled = false;
    api
      .get(`/api/servers/${server.id}/icon-history`)
      .then((data) => {
        if (!cancelled) setIconHistory(data.history || []);
      })
      .catch(() => {
        if (!cancelled) setIconHistory([]);
      });
    return () => {
      cancelled = true;
    };
  }, [server.id, server.iconUrl, canManageServer]);

  useEffect(() => {
    setWelcomeEnabled(!!server.welcomeEnabled);
  }, [server.id, server.welcomeEnabled]);

  useEffect(() => {
    setJoinMessages(server.joinMessages !== false);
  }, [server.id, server.joinMessages]);

  // Scrolling has to wait for the overview tab to mount and for the browser to
  // lay it out, so the jump happens on the next frame rather than during render.
  useEffect(() => {
    if (!focus) return undefined;
    const frame = requestAnimationFrame(() => {
      panelRef.current
        ?.querySelector(`[data-settings-focus="${focus}"]`)
        ?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    });
    return () => cancelAnimationFrame(frame);
  }, [focus, server.id]);

  useEffect(() => {
    if (!canManageServer) return undefined;
    let cancelled = false;
    setWelcomeLoaded(false);
    setWelcomeError('');
    api
      .get(`/api/servers/${server.id}/welcome`)
      .then((payload) => {
        if (cancelled) return;
        setWelcomeChannelId(payload.channelId ? String(payload.channelId) : '');
        setWelcomeTitle(payload.title || '');
        setWelcomeBody(payload.body || '');
        setWelcomeRules((payload.rules || []).join('\n'));
        setWelcomeLoaded(true);
      })
      .catch((err) => {
        // Stay locked: saving an unread form would PATCH empty values over the
        // stored welcome message. The card offers a retry instead.
        if (cancelled) return;
        setWelcomeLoaded(false);
        setWelcomeError(err?.message || 'Could not load the welcome message.');
      });
    return () => {
      cancelled = true;
    };
  }, [server.id, canManageServer, welcomeAttempt]);

  useEffect(() => {
    if (tab === 'channels' && !canManageChannels) setTab('overview');
    if (tab === 'data' && !canManageServer && !canImportData) setTab('overview');
  }, [tab, canManageChannels, canManageServer, canImportData]);

  useEffect(() => {
    if (creatingGroup) return;
    if (!groups.length) {
      setSelectedGroupId(null);
      return;
    }
    if (!groups.some((group) => group.id === selectedGroupId)) {
      setSelectedGroupId(groups[0].id);
    }
  }, [groups, selectedGroupId, creatingGroup]);

  // Keyed on the group id, not the object: a server:updated broadcast rebuilds
  // every group object and would otherwise reset unsaved permission toggles.
  useEffect(() => {
    if (creatingGroup) return;
    if (!selectedGroup) {
      setGroupDraft(null);
      return;
    }
    setGroupDraft({
      name: selectedGroup.name,
      color: selectedGroup.color,
      displaySeparately: !!selectedGroup.displaySeparately,
      categoryId: selectedGroup.categoryId ?? null,
      permissions: [...selectedGroup.permissions]
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedGroup?.id, creatingGroup]);

  // The "Saved"/"Copied" flashes outlive the panel otherwise and fire state
  // updates after unmount.
  useEffect(
    () => () => {
      if (welcomeSavedTimer.current) clearTimeout(welcomeSavedTimer.current);
      if (copiedTimer.current) clearTimeout(copiedTimer.current);
    },
    []
  );

  const groupedPermissions = useMemo(() => permissionGroups(), []);
  const myPermissions = useMemo(
    () => SERVER_PERMISSIONS.filter((permission) => hasServerPermission(server, me, permission)),
    [server, me]
  );

  function chooseIcon(event) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      setError('Choose an image file for the server icon.');
      return;
    }
    setError('');
    setCropFile(file);
  }

  async function applyCrop(blob) {
    setBusy('icon-upload');
    setError('');
    try {
      const extension = blob.type === 'image/jpeg' ? 'jpg' : 'webp';
      const file = new File([blob], `server-icon.${extension}`, {
        type: blob.type || 'image/webp'
      });
      const data = await api.upload(file);
      setIconUrl(data.attachment.url);
      setCropFile(null);
    } catch (err) {
      setError(err.message);
      throw err;
    } finally {
      setBusy('');
    }
  }

  async function restoreIcon(entry) {
    setBusy('icon-restore');
    setError('');
    try {
      const data = await api.patch(`/api/servers/${server.id}`, {
        iconUrl: entry.iconUrl
      });
      setIconUrl(entry.iconUrl);
      onUpdated(data.server);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy('');
    }
  }

  async function saveGeneral() {
    setBusy('save');
    setError('');
    try {
      const data = await api.patch(`/api/servers/${server.id}`, {
        name,
        description,
        iconColor,
        iconUrl
      });
      // Re-seed from our own save (the broadcast is ignored by the id-keyed
      // effect), so server-side normalisation still lands in the form.
      if (data.server) {
        setName(data.server.name);
        setDescription(data.server.description || '');
        setIconColor(data.server.iconColor);
        setIconUrl(data.server.iconUrl || '');
      }
      onUpdated(data.server);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy('');
    }
  }

  async function saveArchiveWindow(event) {
    const minutes = Number(event.target.value);
    setBusy('archive');
    setError('');
    try {
      const data = await api.patch(`/api/servers/${server.id}`, {
        threadArchiveMinutes: minutes
      });
      onUpdated(data.server);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy('');
    }
  }

  async function saveExternalEmotes(event) {
    const allowExternalEmotes = event.target.checked;
    setBusy('emotes');
    setError('');
    try {
      const data = await api.patch(`/api/servers/${server.id}`, { allowExternalEmotes });
      onUpdated(data.server);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy('');
    }
  }

  async function saveWelcome() {
    // The form is only editable once the stored record has been read, so this
    // is a belt-and-braces guard against a PATCH of empty values.
    if (!welcomeLoaded) return;
    if (welcomeTitle.length > 80) {
      setError('Welcome title must be 80 characters or fewer.');
      return;
    }
    if (welcomeBody.length > 1000) {
      setError('Welcome message must be 1000 characters or fewer.');
      return;
    }
    if (welcomeRuleLines.length > 8) {
      setError('A welcome screen can list up to 8 house rules.', 'welcome');
      return;
    }
    if (welcomeRuleLines.some((rule) => rule.length > 120)) {
      setError('Each house rule must be 120 characters or fewer.', 'welcome');
      return;
    }
    setBusy('welcome');
    setError('');
    try {
      const data = await api.patch(`/api/servers/${server.id}`, {
        welcomeEnabled,
        welcomeChannelId: welcomeChannelId ? Number(welcomeChannelId) : null,
        welcomeTitle,
        welcomeBody,
        welcomeRules: welcomeRuleLines
      });
      onUpdated(data.server);
      setWelcomeSaved(true);
      if (welcomeSavedTimer.current) clearTimeout(welcomeSavedTimer.current);
      welcomeSavedTimer.current = setTimeout(() => {
        welcomeSavedTimer.current = null;
        setWelcomeSaved(false);
      }, 1800);
    } catch (err) {
      setError(err.message, 'welcome');
    } finally {
      setBusy('');
    }
  }

  // The switch saves on click: there is nothing else on the card to batch with,
  // and a toggle that needs a Save button reads as broken.
  async function saveJoinMessages(next) {
    setJoinMessages(next);
    setBusy('joinMessages');
    setError('');
    try {
      const data = await api.patch(`/api/servers/${server.id}`, { joinMessages: next });
      onUpdated(data.server);
      setJoinSaved(true);
      if (joinSavedTimer.current) clearTimeout(joinSavedTimer.current);
      joinSavedTimer.current = setTimeout(() => {
        joinSavedTimer.current = null;
        setJoinSaved(false);
      }, 1800);
    } catch (err) {
      setJoinMessages(!next);
      setError(err.message, 'joinMessages');
    } finally {
      setBusy('');
    }
  }

  async function saveDiscovery(patch) {
    setBusy('discover');
    setError('');
    try {
      const data = await api.patch(`/api/servers/${server.id}`, patch);
      onUpdated(data.server);
    } catch (err) {
      setError(err.message, 'discover');
    } finally {
      setBusy('');
    }
  }

  async function saveBanner(nextBanner, file) {
    setBusy('banner');
    setError('');
    try {
      let value = nextBanner;
      if (file) {
        const uploaded = await api.upload(file);
        value = uploaded.attachment.url;
      }
      const data = await api.patch(`/api/servers/${server.id}`, { banner: value });
      setBannerUrl(data.server.banner || '');
      onUpdated(data.server);
    } catch (err) {
      setError(err.message, 'banner');
    } finally {
      setBusy('');
    }
  }

  function chooseBanner(event) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      setError('Choose an image file for the server banner.');
      return;
    }
    saveBanner('', file);
  }

  async function toggleBoost() {
    // Unknown boost state must not be treated as "not boosted", or a re-click
    // by an existing booster adds a second boost / errors.
    if (myBoost === null) return;
    const adding = !myBoost;
    setBusy('boost');
    setError('');
    try {
      const data = await api.post(`/api/servers/${server.id}/boost`, {
        action: adding ? 'add' : 'remove'
      });
      setMyBoost(typeof data.boosted === 'boolean' ? data.boosted : adding);
      if (data.server) onUpdated(data.server);
    } catch (err) {
      setError(err.message, 'boost');
    } finally {
      setBusy('');
    }
  }

  async function regenerate() {
    setBusy('regen');
    setError('');
    try {
      const data = await api.post(`/api/servers/${server.id}/invite/regenerate`);
      setInviteCode(data.inviteCode);
      setCodeDraft(data.inviteCode);
      onUpdated(data.server);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy('');
    }
  }

  async function saveCustomCode(event) {
    event.preventDefault();
    setBusy('code');
    setError('', 'invite');
    try {
      const data = await api.put(`/api/servers/${server.id}/invite/code`, { code: codeDraft });
      setInviteCode(data.inviteCode);
      setCodeDraft(data.inviteCode);
      onUpdated(data.server);
      setCodeSaved(true);
      if (codeSavedTimer.current) clearTimeout(codeSavedTimer.current);
      codeSavedTimer.current = setTimeout(() => {
        codeSavedTimer.current = null;
        setCodeSaved(false);
      }, 1800);
    } catch (err) {
      setError(err.message, 'invite');
    } finally {
      setBusy('');
    }
  }

  async function copyInvite() {
    try {
      await navigator.clipboard.writeText(inviteUrl);
      setCopied(true);
      if (copiedTimer.current) clearTimeout(copiedTimer.current);
      copiedTimer.current = setTimeout(() => {
        copiedTimer.current = null;
        setCopied(false);
      }, 1800);
    } catch {
      setError('Could not copy. Select the link and copy manually.');
    }
  }

  function startCreateGroup() {
    setCreatingGroup(true);
    setSelectedGroupId(null);
    setGroupDraft({
      name: '',
      color: AVATAR_COLORS[0],
      displaySeparately: false,
      categoryId: null,
      permissions: [...DEFAULT_MEMBER_PERMISSIONS]
    });
    setError('');
  }

  function selectGroup(group) {
    setCreatingGroup(false);
    setSelectedGroupId(group.id);
  }

  function startGroupDrag(event, group) {
    if (!canReorderGroups || group.isDefault) {
      event.preventDefault();
      return;
    }
    setDraggingGroupId(group.id);
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', String(group.id));
  }

  function handleGroupDragOver(event, group) {
    if (!canReorderGroups || !draggingGroupId || group.id === draggingGroupId) return;
    event.preventDefault();
    const rect = event.currentTarget.getBoundingClientRect();
    const after = !group.isDefault && event.clientY > rect.top + rect.height / 2;
    setDragOverGroup({ id: group.id, after });
    event.dataTransfer.dropEffect = 'move';
  }

  function endGroupDrag() {
    setDraggingGroupId(null);
    setDragOverGroup(null);
  }

  async function dropGroup(event, targetGroup) {
    event.preventDefault();
    const draggedId = Number(event.dataTransfer.getData('text/plain')) || draggingGroupId;
    const after = dragOverGroup?.id === targetGroup.id ? dragOverGroup.after : false;
    endGroupDrag();
    if (!draggedId || draggedId === targetGroup.id || !canReorderGroups) return;

    const draggedGroup = groups.find((group) => group.id === draggedId);
    if (!draggedGroup || draggedGroup.isDefault) return;

    const remaining = groups.filter((group) => group.id !== draggedId);
    let insertAt = remaining.findIndex((group) => group.id === targetGroup.id);
    if (insertAt < 0) return;
    if (after) insertAt += 1;
    const defaultIndex = remaining.findIndex((group) => group.isDefault);
    if (defaultIndex >= 0) insertAt = Math.min(insertAt, defaultIndex);
    const next = [...remaining];
    next.splice(insertAt, 0, draggedGroup);
    if (next.map((group) => group.id).join(',') === groups.map((group) => group.id).join(',')) {
      return;
    }

    setBusy('group-order');
    setError('');
    try {
      const data = await api.put(`/api/servers/${server.id}/groups/order`, {
        groupIds: next.map((group) => group.id)
      });
      onUpdated(data.server);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy('');
    }
  }

  function toggleDraftPermission(permission) {
    if (!canEditSelected) return;
    setGroupDraft((prev) => {
      if (!prev) return prev;
      const has = prev.permissions.includes(permission);
      return {
        ...prev,
        permissions: has
          ? prev.permissions.filter((entry) => entry !== permission)
          : [...prev.permissions, permission]
      };
    });
  }

  async function saveGroup() {
    if (!groupDraft) return;
    setBusy('group-save');
    setError('');
    try {
      if (creatingGroup) {
        const data = await api.post(`/api/servers/${server.id}/groups`, groupDraft);
        onUpdated(data.server);
        setCreatingGroup(false);
        setSelectedGroupId(data.group?.id || data.server.groups[0]?.id || null);
      } else if (selectedGroup) {
        const data = await api.patch(`/api/servers/${server.id}/groups/${selectedGroup.id}`, groupDraft);
        onUpdated(data.server);
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy('');
    }
  }

  async function createCategory() {
    const name = categoryDraft.trim();
    if (!name) return;
    setBusy('category-save');
    setError('');
    try {
      const data = await api.post(`/api/servers/${server.id}/group-categories`, {
        name,
        color: categoryDraftColor
      });
      onUpdated(data.server);
      setCategoryDraft('');
      setCategoryPresetsOpen(false);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy('');
    }
  }

  async function deleteCategory(categoryId) {
    setBusy(`category-delete-${categoryId}`);
    setError('');
    try {
      const data = await api.del(`/api/servers/${server.id}/group-categories/${categoryId}`);
      onUpdated(data.server);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy('');
    }
  }

  async function deleteGroup() {
    if (!selectedGroup) return;
    if (!window.confirm(`Delete the ${selectedGroup.name} group?`)) return;
    setBusy('group-delete');
    setError('');
    try {
      const data = await api.del(`/api/servers/${server.id}/groups/${selectedGroup.id}`);
      onUpdated(data.server);
      setSelectedGroupId(data.server.groups[0]?.id || null);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy('');
    }
  }

  function startEditMember(member) {
    setEditingMemberId(member.id);
    setMemberGroupDraft(visibleGroups(member).map((group) => group.id));
    setError('');
  }

  function cancelEditMember() {
    setEditingMemberId(null);
    setMemberGroupDraft([]);
  }

  function toggleMemberGroup(groupId) {
    setMemberGroupDraft((prev) =>
      prev.includes(groupId) ? prev.filter((id) => id !== groupId) : [...prev, groupId]
    );
  }

  async function saveMemberGroups(member) {
    setBusy(`member-groups-${member.id}`);
    setError('');
    try {
      const data = await api.put(`/api/servers/${server.id}/members/${member.id}/groups`, {
        groupIds: memberGroupDraft
      });
      onUpdated(data.server);
      cancelEditMember();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy('');
    }
  }

  async function kick(member) {
    if (!window.confirm(`Remove ${member.displayName} from ${server.name}?`)) return;
    setBusy(`kick-${member.id}`);
    setError('');
    try {
      await api.del(`/api/servers/${server.id}/members/${member.id}`);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy('');
    }
  }

  async function leave() {
    if (!window.confirm(`Leave ${server.name}?`)) return;
    setBusy('leave');
    setError('');
    try {
      await api.post(`/api/servers/${server.id}/leave`);
      onRemoved(server.id);
    } catch (err) {
      setError(err.message);
      setBusy('');
    }
  }

  async function destroy() {
    if (!window.confirm(`Delete ${server.name} permanently? All channels and messages will be lost.`)) {
      return;
    }
    setBusy('delete');
    setError('');
    try {
      await api.del(`/api/servers/${server.id}`);
      onRemoved(server.id);
    } catch (err) {
      setError(err.message);
      setBusy('');
    }
  }

  return (
    <div className="server-settings-panel" ref={panelRef}>
      <div className="settings-subtabs-row">
        <div className="settings-subtabs">
          {visibleTabs.map((entry) => (
            <button
              key={entry.id}
              className={`settings-subtab ${tab === entry.id ? 'active' : ''}`}
              onClick={() => setTab(entry.id)}
            >
              {entry.label}
            </button>
          ))}
        </div>
        {boostLevel >= 1 && <span className="boost-badge">Boosted</span>}
      </div>

      {error && !errorScope && <div className="form-error">{error}</div>}

      {tab === 'overview' && (
        <div className="server-settings">
          <div className="settings-section-head">
            <div>
              <h3>Server overview</h3>
              <p>Name, icon, description, and accent shown across Cordia.</p>
            </div>
            {canManageServer && (
              <button
                className="btn btn-primary btn-sm"
                onClick={saveGeneral}
                disabled={busy === 'save' || busy === 'icon-upload' || busy === 'icon-restore'}
              >
                {busy === 'save' ? <Loader2 size={15} className="spin" /> : <Save size={15} />}
                Save
              </button>
            )}
          </div>

          {canManageServer && (
            <InsightsCard serverId={server.id} />
          )}
          <label className="field">
            <span>Server name</span>
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              maxLength={48}
              disabled={!canManageServer}
            />
          </label>

          <label className="field">
            <span>Description</span>
            <textarea
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              maxLength={280}
              rows={3}
              placeholder="What is this server for?"
              disabled={!canManageServer}
            />
            <small className="field-hint">{description.length}/280</small>
          </label>

          <div className="server-icon-editor" data-settings-focus="identity">
            <ServerIcon
              server={{ ...server, name, iconUrl, iconColor }}
              className="server-icon-preview"
            />
            <div className="server-icon-editor-copy">
              <span className="settings-label">Server icon</span>
              <p>Shown in the server rail, settings, and profiles.</p>
              {canManageServer && (
                <div className="server-icon-editor-actions">
                  <label className="btn btn-ghost btn-sm">
                    {busy === 'icon-upload' ? (
                      <Loader2 size={15} className="spin" />
                    ) : (
                      <Camera size={15} />
                    )}
                    {iconUrl ? 'Replace icon' : 'Upload icon'}
                    <input
                      type="file"
                      accept="image/*"
                      hidden
                      onChange={chooseIcon}
                      disabled={busy === 'icon-upload'}
                    />
                  </label>
                  {iconUrl && (
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      onClick={() => setIconUrl('')}
                    >
                      <Trash2 size={15} /> Remove icon
                    </button>
                  )}
                </div>
              )}
              <small className="field-hint">You'll choose the crop before upload. PNG, JPG, GIF, WebP, or AVIF.</small>
            </div>
          </div>

          <div className="settings-access-card">
            <div>
              <span className="settings-label">Discovery banner</span>
              <p>A wide 3:1 image across the top of your card in Discover.</p>
              {bannerUrl && (
                <img
                  className="settings-banner-preview"
                  src={assetUrl(bannerUrl)}
                  alt=""
                />
              )}
            </div>
            {canManageServer && (
              <div className="invite-code-actions">
                <label className="btn btn-ghost btn-sm">
                  {busy === 'banner' ? <Loader2 size={15} className="spin" /> : <Camera size={15} />}
                  {bannerUrl ? 'Replace banner' : 'Upload banner'}
                  <input
                    type="file"
                    accept="image/*"
                    hidden
                    onChange={chooseBanner}
                    disabled={busy === 'banner'}
                  />
                </label>
                {bannerUrl && (
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    onClick={() => saveBanner('')}
                    disabled={busy === 'banner'}
                  >
                    <Trash2 size={15} /> Remove
                  </button>
                )}
              </div>
            )}
            {error && errorScope === 'banner' && <div className="form-error">{error}</div>}
          </div>

          <div className="server-icon-live">
            <span className="settings-label">Live previews</span>
            <div className="server-icon-live-row">
              <span className="server-icon-live-item">
                <ServerIcon
                  server={{ ...server, name, iconUrl, iconColor }}
                  className="server-icon-live-rail"
                />
                Rail
              </span>
              <span className="server-icon-live-item">
                <ServerIcon
                  server={{ ...server, name, iconUrl, iconColor }}
                  className="server-icon-live-nav"
                />
                Settings
              </span>
              <span className="server-icon-live-item">
                <ServerIcon
                  server={{ ...server, name, iconUrl, iconColor }}
                  className="server-icon-live-profile"
                />
                Profile
              </span>
            </div>
          </div>

          {canManageServer && iconHistory.length > 0 && (
            <div className="server-icon-history">
              <span className="settings-label">Recent icons</span>
              <div className="server-icon-history-row">
                {iconHistory.map((entry) => (
                  <button
                    key={entry.id}
                    type="button"
                    className="server-icon-history-item"
                    onClick={() => restoreIcon(entry)}
                    disabled={busy === 'icon-restore'}
                    title={`${entry.iconUrl ? 'Restore this icon' : 'Restore default icon'}${
                      entry.changedBy ? ` (saved by ${entry.changedBy})` : ''
                    }`}
                    aria-label={`${entry.iconUrl ? 'Restore this icon' : 'Restore default icon'}${
                      entry.changedBy ? ` saved by ${entry.changedBy}` : ''
                    }`}
                  >
                    <ServerIcon
                      server={{ ...server, name, iconUrl: entry.iconUrl, iconColor }}
                    />
                  </button>
                ))}
              </div>
              <small className="field-hint">Click an icon to restore it.</small>
            </div>
          )}

          <ServerIconSuggestions
            server={server}
            me={me}
            socket={socket}
            // Applying a suggestion changes the icon server-side; the id-keyed
            // re-seed no longer picks that up, so adopt it here or the next
            // Save in this card would revert it.
            onUpdated={(next) => {
              setIconUrl(next.iconUrl || '');
              onUpdated(next);
            }}
          />

          <div className="field">
            <span>Server accent</span>
            <div className="swatches">
              {AVATAR_COLORS.map((color) => (
                <button
                  key={color}
                  className={`swatch ${iconColor === color ? 'active' : ''}`}
                  style={{ background: color }}
                  onClick={() => canManageServer && setIconColor(color)}
                  disabled={!canManageServer}
                  aria-label={`Server color ${color}`}
                />
              ))}
            </div>
          </div>

          <div className="invite-code-box">
            <div>
              <span className="settings-label">Invite link</span>
              <strong className="invite-code" style={{ letterSpacing: 0, overflowWrap: 'anywhere' }}>
                {inviteUrl}
              </strong>
            </div>
            <div className="invite-code-actions">
              <button className="btn btn-ghost btn-sm" onClick={copyInvite}>
                {copied ? <Check size={15} /> : <Copy size={15} />} {copied ? 'Copied' : 'Copy link'}
              </button>
              {canManageServer && (
                <button className="btn btn-ghost btn-sm" onClick={regenerate} disabled={busy === 'regen'}>
                  {busy === 'regen' ? <Loader2 size={15} className="spin" /> : <RefreshCw size={15} />}
                  New link
                </button>
              )}
              {canManageServer && (
                <button className="btn btn-ghost btn-sm" onClick={() => setShowInvites(true)}>
                  Limited links
                </button>
              )}
            </div>
          </div>

          {canManageServer && (
            <form className="invite-custom" onSubmit={saveCustomCode}>
              <span className="settings-label">Custom link</span>
              <div className="invite-custom-row">
                <span className="invite-custom-prefix">/invite/</span>
                <input
                  className="input"
                  value={codeDraft}
                  onChange={(event) => setCodeDraft(event.target.value)}
                  disabled={!canEditCode || busy === 'code'}
                  maxLength={32}
                  placeholder="my-server"
                  autoComplete="off"
                  spellCheck="false"
                  aria-label="Custom invite link"
                />
                <button
                  className="btn btn-sm"
                  type="submit"
                  disabled={
                    !canEditCode ||
                    busy === 'code' ||
                    !codeDraft.trim() ||
                    codeDraft.trim().toLowerCase() === String(inviteCode).toLowerCase()
                  }
                >
                  {busy === 'code' ? (
                    <Loader2 size={15} className="spin" />
                  ) : codeSaved ? (
                    <Check size={15} />
                  ) : (
                    <Save size={15} />
                  )}
                  {codeSaved ? 'Saved' : 'Save'}
                </button>
              </div>
              {!canEditCode && inviteVanity ? (
                <small className="field-hint">
                  Custom links unlock on {formatDate(inviteVanity.unlockAt)}: your account has to be{' '}
                  {inviteVanity.accountDays} days old and the server {inviteVanity.serverDays} days old.
                </small>
              ) : (
                <small className="field-hint">
                  Letters, numbers and dashes. Changing it breaks the old link immediately.
                </small>
              )}
              {error && errorScope === 'invite' && <div className="form-error">{error}</div>}
            </form>
          )}

          <div className="settings-access-card">
            <div>
              <span className="settings-label">Threads</span>
              <p>Idle threads archive themselves; posting reopens them.</p>
            </div>
            <label className="field-inline">
              <select
                value={server.threadArchiveMinutes ?? 1440}
                onChange={saveArchiveWindow}
                disabled={!canManageServer || busy === 'archive'}
                aria-label="Thread auto-archive window"
              >
                <option value={60}>After 1 hour</option>
                <option value={1440}>After 24 hours</option>
                <option value={4320}>After 3 days</option>
                <option value={10080}>After 1 week</option>
                <option value={0}>Never</option>
              </select>
            </label>
          </div>

          <div className="settings-access-card">
            <div>
              <span className="settings-label">Emotes from other servers</span>
              <p>Members can use custom emotes from their other servers in this one.</p>
            </div>
            <label className="field-inline">
              <input
                type="checkbox"
                checked={server.allowExternalEmotes !== false}
                onChange={saveExternalEmotes}
                disabled={!canManageServer || busy === 'emotes'}
                aria-label="Emotes from other servers"
              />
            </label>
          </div>

          {canManageServer && (
            <div className="settings-access-card welcome-settings" data-settings-focus="welcome">
              <div className="welcome-settings-head">
                <div>
                  <span className="settings-label">Welcome screen</span>
                  <p>
                    A one-time card members see the first time they open this server.
                    {welcomeChannelName ? ` New members are pointed at #${welcomeChannelName}.` : ''}
                  </p>
                </div>
                <div className="welcome-settings-actions">
                  <label className="field-inline">
                    <input
                      type="checkbox"
                      checked={welcomeEnabled}
                      onChange={(event) => setWelcomeEnabled(event.target.checked)}
                      disabled={!welcomeLoaded || busy === 'welcome'}
                      aria-label="Enable the welcome screen"
                    />
                    <span>Enabled</span>
                  </label>
                  <button
                    className="btn btn-primary btn-sm"
                    onClick={saveWelcome}
                    disabled={!welcomeLoaded || busy === 'welcome'}
                  >
                    {busy === 'welcome' ? (
                      <Loader2 size={15} className="spin" />
                    ) : welcomeSaved ? (
                      <Check size={15} />
                    ) : (
                      <Save size={15} />
                    )}
                    {welcomeSaved ? 'Saved' : 'Save'}
                  </button>
                </div>
              </div>

              {welcomeError && (
                <div className="form-error" role="alert">
                  <span>{welcomeError} The saved message is untouched.</span>
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    onClick={() => setWelcomeAttempt((attempt) => attempt + 1)}
                  >
                    <RefreshCw size={14} /> Retry
                  </button>
                </div>
              )}

              <div className="welcome-settings-grid">
                <label className="field">
                  <span>Welcome channel</span>
                  <select
                    value={welcomeChannelId}
                    onChange={(event) => setWelcomeChannelId(event.target.value)}
                    disabled={!welcomeLoaded || busy === 'welcome'}
                  >
                    <option value="">No channel</option>
                    {textChannels.map((channel) => (
                      <option key={channel.id} value={channel.id}>
                        #{channel.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="field">
                  <span>Title</span>
                  <input
                    value={welcomeTitle}
                    onChange={(event) => setWelcomeTitle(event.target.value)}
                    maxLength={80}
                    placeholder={`Welcome to ${server.name}`}
                    disabled={!welcomeLoaded || busy === 'welcome'}
                  />
                  <small className="field-hint">{welcomeTitle.length}/80</small>
                </label>
              </div>

              <label className="field">
                <span>Message</span>
                <textarea
                  value={welcomeBody}
                  onChange={(event) => setWelcomeBody(event.target.value)}
                  maxLength={1000}
                  rows={4}
                  placeholder="What should a new member know first?"
                  disabled={!welcomeLoaded || busy === 'welcome'}
                />
                <small className="field-hint">{welcomeBody.length}/1000</small>
              </label>

              <label className="field">
                <span>House rules</span>
                <textarea
                  value={welcomeRules}
                  onChange={(event) => setWelcomeRules(event.target.value)}
                  rows={3}
                  placeholder={'One rule per line, e.g. Be kind in every channel.'}
                  disabled={!welcomeLoaded || busy === 'welcome'}
                />
                <small className="field-hint">
                  One per line · {welcomeRuleLines.length}/8
                </small>
              </label>

              <div className="welcome-settings-preview">
                <span className="settings-label">Members will see</span>
                <strong>{welcomeTitle.trim() || `Welcome to ${server.name}`}</strong>
                <p className="welcome-body">
                  {welcomeBody.trim() || 'Your message appears here, line breaks and all.'}
                </p>
                {welcomeRuleLines.length > 0 && (
                  <div className="welcome-rules welcome-rules-preview">
                    <span className="settings-label">House rules</span>
                    <ol>
                      {welcomeRuleLines.map((rule, index) => (
                        <li key={`${index}-${rule}`}>{rule}</li>
                      ))}
                    </ol>
                  </div>
                )}
              </div>
              {error && errorScope === 'welcome' && <div className="form-error">{error}</div>}
            </div>
          )}

          <div className="settings-access-card" data-settings-focus="presence">
            <div>
              <span className="settings-label">Join &amp; leave messages</span>
              <p>
                Post a line in the channel above whenever someone joins, leaves, or is
                removed. Turn this off on busy servers.
              </p>
            </div>
            <label className="field-inline">
              <input
                type="checkbox"
                checked={joinMessages}
                onChange={(event) => saveJoinMessages(event.target.checked)}
                disabled={!canManageServer || busy === 'joinMessages'}
                aria-label="Post join and leave messages"
              />
              <span>{joinSaved ? 'Saved' : 'Enabled'}</span>
            </label>
            {error && errorScope === 'joinMessages' && <div className="form-error">{error}</div>}
          </div>

          <div className="settings-access-card">
            <div>
              <span className="settings-label">Discovery</span>
              <p>List this server in Discover so anyone can find and join it.</p>
            </div>
            <label className="field-inline">
              <input
                type="checkbox"
                checked={!!server.discoverable}
                onChange={(event) => saveDiscovery({ discoverable: event.target.checked })}
                disabled={!canManageServer || busy === 'discover'}
                aria-label="List this server in Discover"
              />
            </label>
            <label className="field-inline">
              <select
                value={server.discoverCategory || 'Community'}
                onChange={(event) => saveDiscovery({ discoverCategory: event.target.value })}
                disabled={!canManageServer || !server.discoverable || busy === 'discover'}
                aria-label="Discover category"
              >
                {DISCOVER_CATEGORIES.map((category) => (
                  <option key={category} value={category}>
                    {category}
                  </option>
                ))}
              </select>
            </label>
            {error && errorScope === 'discover' && <div className="form-error">{error}</div>}
          </div>

          <div className="settings-access-card">
            <div>
              <span className="settings-label">
                Boost
                {boostLevel >= 1 && <span className="boost-badge">Boosted</span>}
              </span>
              <p>
                {boostCount} {boostCount === 1 ? 'boost' : 'boosts'} · Level {boostLevel}
              </p>
              <div
                className="boost-progress"
                role="progressbar"
                aria-label="Boost progress"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={boostProgress}
              >
                <span style={{ width: `${boostProgress}%` }} />
              </div>
              <small className="field-hint">
                {nextBoostTier
                  ? `${boostCount} / ${nextBoostTier} to Level ${boostLevel + 1}`
                  : 'Maximum level reached'}
              </small>
            </div>
            {membership ? (
              <button
                className={`btn btn-sm ${myBoost ? 'btn-ghost' : 'btn-primary'}`}
                onClick={toggleBoost}
                disabled={busy === 'boost' || !boostStatusLoaded}
                title={!boostStatusLoaded ? 'Checking your boost status' : undefined}
              >
                {busy === 'boost' && <Loader2 size={14} className="spin" />}
                {myBoost ? 'Remove boost' : 'Boost this server'}
              </button>
            ) : (
              <small className="field-hint">Only members can boost this server.</small>
            )}
            {boostStatusError && (
              <div className="form-error" role="alert">
                <span>{boostStatusError} The boost count is unchanged.</span>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  onClick={() => setBoostAttempt((attempt) => attempt + 1)}
                >
                  <RefreshCw size={14} /> Retry
                </button>
              </div>
            )}
            {error && errorScope === 'boost' && <div className="form-error">{error}</div>}
          </div>

          <div className="settings-access-card">
            <div>
              <span className="settings-label">Your access</span>
              <p>
                {isOwner
                  ? 'You own this server and can manage everything.'
                  : myPermissions.length
                    ? 'Your groups grant these permissions.'
                    : 'You have no special permissions in this server.'}
              </p>
            </div>
            <div className="permission-chip-row">
              {myPermissions.length ? (
                myPermissions.map((permission) => (
                  <span className="permission-chip" key={permission}>
                    {PERMISSION_META.find((entry) => entry.key === permission)?.label || permission}
                  </span>
                ))
              ) : (
                <span className="permission-chip muted">Member access</span>
              )}
            </div>
          </div>

          <div className="danger-zone">
            <div>
              <h4>Danger zone</h4>
              <p>
                {ownerOrAdmin
                  ? 'Deleting a server removes every channel, message and membership forever.'
                  : 'Leaving is reversible with a new invite.'}
              </p>
            </div>
            {ownerOrAdmin ? (
              <button className="btn btn-danger btn-sm" onClick={destroy} disabled={busy === 'delete'}>
                <Trash2 size={15} /> Delete server
              </button>
            ) : (
              <button className="btn btn-danger btn-sm" onClick={leave} disabled={busy === 'leave'}>
                <LogOut size={15} /> Leave server
              </button>
            )}
          </div>
        </div>
      )}

      {tab === 'channels' && (
        <div className="server-settings">
          <ChannelManager
            server={server}
            canManage={canManageChannels}
            onUpdated={onUpdated}
          />
        </div>
      )}

      {tab === 'emotes' && (
        <ServerEmotes server={server} canManage={canManageServer} onUpdated={onUpdated} />
      )}

      {tab === 'tiers' && (
        <Suspense fallback={<p className="channel-empty">Loading subscriptions...</p>}>
          <ServerTiersPanel server={server} canManage={canManageServer} onUpdated={onUpdated} />
        </Suspense>
      )}
      {tab === 'groups' && (
        <div className="server-settings">
          <div className="settings-section-head">
            <div>
              <h3>Groups and permissions</h3>
              <p>
                Group permissions stack on top of the default Members group. Drag groups to set
                rank; higher groups outrank lower ones.
              </p>
            </div>
            {canManageGroups && (
              <button className="btn btn-primary btn-sm" onClick={startCreateGroup}>
                <Plus size={15} /> New group
              </button>
            )}
          </div>

          <div className="server-groups-layout">
            <div className="server-group-list">
              {groupSections.map((section) => (
                <div className="group-section" key={section.key}>
                  {section.name && (
                    <div className="group-section-head">
                      <span>{section.name}</span>
                    </div>
                  )}
                  {section.groups.map((group) => {
                const dragging = draggingGroupId === group.id;
                const dragOver = dragOverGroup?.id === group.id;
                return (
                  <button
                    key={group.id}
                    className={`server-group-item ${
                      !creatingGroup && group.id === selectedGroupId ? 'active' : ''
                    } ${dragging ? 'dragging' : ''} ${
                      dragOver ? (dragOverGroup.after ? 'drag-over-after' : 'drag-over-before') : ''
                    }`}
                    draggable={canReorderGroups && !group.isDefault}
                    onClick={() => selectGroup(group)}
                    onDragStart={(event) => startGroupDrag(event, group)}
                    onDragEnd={endGroupDrag}
                    onDragOver={(event) => handleGroupDragOver(event, group)}
                    onDrop={(event) => dropGroup(event, group)}
                  >
                    {canReorderGroups && !group.isDefault ? (
                      <span className="group-drag-handle" title="Drag to reorder" aria-hidden="true">
                        <GripVertical size={14} />
                      </span>
                    ) : (
                      <span className="group-drag-handle group-drag-handle--locked" aria-hidden="true" />
                    )}
                    <span className="group-color-dot" style={{ background: group.color }} />
                    <span className="server-group-item-copy">
                      <strong>{group.name}</strong>
                      <small>
                        {group.isDefault
                          ? 'All members'
                          : `${groupMemberCount(server, group.id)} members`}
                      </small>
                    </span>
                    {group.isDefault && <span className="group-default-tag">Default</span>}
                    <span className="group-permission-count">{permissionCount(group)} perms</span>
                  </button>
                );
                  })}
                </div>
              ))}
              {creatingGroup && (
                <button className="server-group-item active" onClick={() => {}}>
                  <span className="group-color-dot" style={{ background: groupDraft?.color }} />
                  <span className="server-group-item-copy">
                    <strong>{groupDraft?.name || 'New group'}</strong>
                    <small>Not saved yet</small>
                  </span>
                </button>
              )}
            </div>

            {canManageGroups && (
              <div className="group-category-bar">
                <div className="group-category-compose">
                  <button
                    type="button"
                    className="group-category-color"
                    style={{ background: categoryDraftColor }}
                    onClick={() => setCategoryPresetsOpen((open) => !open)}
                    title="Category colour"
                    aria-label="Category colour"
                    aria-expanded={categoryPresetsOpen}
                  />
                  <input
                    className="input"
                    value={categoryDraft}
                    maxLength={32}
                    placeholder="New role category"
                    onChange={(event) => setCategoryDraft(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') {
                        event.preventDefault();
                        createCategory();
                      }
                    }}
                  />
                  <button
                    type="button"
                    className="btn btn-primary btn-sm"
                    disabled={!categoryDraft.trim() || busy === 'category-save'}
                    onClick={createCategory}
                  >
                    {busy === 'category-save' ? <Loader2 size={13} className="spin" /> : <Plus size={13} />} Add
                  </button>
                </div>
                {categoryPresetsOpen && (
                  <div className="group-category-presets">
                    {AVATAR_COLORS.map((color) => (
                      <button
                        key={color}
                        type="button"
                        className={`swatch ${categoryDraftColor === color ? 'active' : ''}`}
                        style={{ background: color }}
                        onClick={() => setCategoryDraftColor(color)}
                        aria-label={`Category colour ${color}`}
                      />
                    ))}
                    <label className="group-category-custom" title="Pick any colour">
                      <input
                        type="color"
                        value={categoryDraftColor}
                        onChange={(event) => setCategoryDraftColor(event.target.value)}
                        aria-label="Custom category colour"
                      />
                      <span style={{ background: categoryDraftColor }} />
                    </label>
                  </div>
                )}
              </div>
            )}
            {groupCategories.length > 0 && (
              <div className="group-category-list">
                {groupCategories.map((category) => (
                  <span className="group-category-chip" key={category.id}>
                    <span
                      className="group-category-dot"
                      style={{ background: category.color || '#7a8798' }}
                    />
                    {category.name}
                    {canManageGroups && (
                      <button
                        type="button"
                        className="group-category-remove"
                        title={`Delete ${category.name}`}
                        onClick={() => deleteCategory(category.id)}
                      >
                        <X size={12} />
                      </button>
                    )}
                  </span>
                ))}
              </div>
            )}
            {groupDraft && (creatingGroup || selectedGroup) ? (
              <div className="server-group-editor">
                <div className="server-group-editor-head">
                  <div>
                    <h4>{creatingGroup ? 'Create group' : groupDraft.name || 'Group'}</h4>
                    <p>
                      {creatingGroup
                        ? 'Pick a name, color, and permissions.'
                        : selectedGroup?.isDefault
                          ? 'This default group applies to every member.'
                          : `${groupMemberCount(server, selectedGroup.id)} members assigned.`}
                    </p>
                  </div>
                  {canEditSelected && (
                    <div className="server-group-editor-actions">
                      {!creatingGroup && !selectedGroup?.isDefault && (
                        <button
                          className="icon-btn danger-hover"
                          onClick={deleteGroup}
                          disabled={busy === 'group-delete'}
                          title="Delete group"
                        >
                          {busy === 'group-delete' ? (
                            <Loader2 size={15} className="spin" />
                          ) : (
                            <Trash2 size={15} />
                          )}
                        </button>
                      )}
                      <button
                        className="btn btn-primary btn-sm"
                        onClick={saveGroup}
                        disabled={busy === 'group-save'}
                      >
                        {busy === 'group-save' ? (
                          <Loader2 size={15} className="spin" />
                        ) : (
                          <Save size={15} />
                        )}
                        {creatingGroup ? 'Create' : 'Save'}
                      </button>
                    </div>
                  )}
                </div>

                <div className="server-group-fields">
                  <label className="field">
                    <span>Group name</span>
                    <input
                      value={groupDraft.name}
                      onChange={(event) =>
                        setGroupDraft((prev) => ({ ...prev, name: event.target.value }))
                      }
                      maxLength={32}
                      disabled={!canEditSelected}
                    />
                  </label>
                  <label className="field">
                    <span>Category</span>
                    <select
                      value={groupDraft.categoryId ?? ''}
                      disabled={!canEditSelected || groupCategories.length === 0}
                      onChange={(event) =>
                        setGroupDraft((prev) => ({
                          ...prev,
                          categoryId: event.target.value ? Number(event.target.value) : null
                        }))
                      }
                    >
                      <option value="">No category</option>
                      {groupCategories.map((category) => (
                        <option key={category.id} value={category.id}>
                          {category.name}
                        </option>
                      ))}
                    </select>
                    {groupCategories.length === 0 && (
                      <small className="field-hint">Create a category below the group list first.</small>
                    )}
                  </label>
                  <div className="field">
                    <span>Group color</span>
                    <div className="swatches">
                      {AVATAR_COLORS.map((color) => (
                        <button
                          key={color}
                          className={`swatch ${groupDraft.color === color ? 'active' : ''}`}
                          style={{ background: color }}
                          onClick={() =>
                            canEditSelected &&
                            setGroupDraft((prev) => ({ ...prev, color }))
                          }
                          disabled={!canEditSelected}
                          aria-label={`Group color ${color}`}
                        />
                      ))}
                    </div>
                  </div>
                  <label
                    className={`group-display-toggle ${
                      !canEditSelected || selectedGroup?.isDefault ? 'disabled' : ''
                    }`}
                  >
                    <input
                      type="checkbox"
                      checked={!!groupDraft.displaySeparately}
                      onChange={(event) =>
                        setGroupDraft((prev) => ({
                          ...prev,
                          displaySeparately: event.target.checked
                        }))
                      }
                      disabled={!canEditSelected || selectedGroup?.isDefault}
                    />
                    <span className="group-display-copy">
                      <strong>Display group separately from others</strong>
                      <small>
                        {selectedGroup?.isDefault
                          ? 'The default group is always shown with everyone.'
                          : 'Show this group in its own section in the member list.'}
                      </small>
                    </span>
                  </label>
                </div>

                <div className="permission-grid">
                  {groupedPermissions.map((section) => (
                    <div className="permission-section" key={section.name}>
                      <div className="permission-section-label">{section.name}</div>
                      {section.permissions.map((permission) => {
                        const checked = groupDraft.permissions.includes(permission.key);
                        const disabled = !canEditSelected || (!canEditDefault && selectedGroup?.isDefault);
                        return (
                          <label
                            className={`permission-row ${checked ? 'checked' : ''} ${
                              disabled ? 'disabled' : ''
                            }`}
                            key={permission.key}
                          >
                            <input
                              type="checkbox"
                              checked={checked}
                              onChange={() => toggleDraftPermission(permission.key)}
                              disabled={disabled}
                            />
                            <span className="permission-check">
                              {checked ? <Check size={12} /> : null}
                            </span>
                            <span className="permission-copy">
                              <strong>{permission.label}</strong>
                              <small>{permission.description}</small>
                            </span>
                          </label>
                        );
                      })}
                    </div>
                  ))}
                </div>
              </div>
            ) : (
              <div className="settings-empty server-group-empty">
                <ShieldCheck size={24} />
                <h3>No group selected</h3>
                <p>Select a group to edit its permissions.</p>
              </div>
            )}
          </div>
        </div>
      )}

      {tab === 'members' && (
        <div className="server-settings">
          <div className="settings-section-head">
            <div>
              <h3>Members</h3>
              <p>{server.members.length} people in {server.name}.</p>
            </div>
          </div>
          <div className="server-members-admin">
            {server.members.map((member) => {
              const memberGroups = visibleGroups(member);
              const canEditGroups = canManageMemberGroups(server, me, member);
              const canRemove = canKick && canManageMember(server, me, member, 'kickMembers');
              const editing = editingMemberId === member.id;
              return (
                <div className="member-admin-wrap" key={member.id}>
                  <div className="member-admin-row">
                    <Avatar user={member} size={34} presence={presence} showPresence />
                    <div className="member-admin-meta">
                      <strong>
                        {member.displayName}
                        {member.id === me.id && <span className="you-tag">you</span>}
                        {member.role === 'admin' && <span className="staff-tag">STAFF</span>}
                      </strong>
                      <span>@{member.username}</span>
                      <div className="member-group-chips">
                        {member.serverRole === 'owner' && (
                          <span className="role-pill owner">
                            <Crown size={12} /> Owner
                          </span>
                        )}
                        {memberGroups.length
                          ? memberGroups.map((group) => (
                              <span
                                className="member-group-chip"
                                key={group.id}
                                style={{
                                  color: group.color,
                                  borderColor: `${group.color}55`,
                                  background: `${group.color}18`
                                }}
                              >
                                {group.name}
                              </span>
                            ))
                          : member.serverRole !== 'owner' && (
                              <span className="member-group-empty">{defaultGroupName}</span>
                            )}
                      </div>
                    </div>
                    <div className="member-admin-role">
                      {canEditGroups && !editing && (
                        <button
                          className="btn btn-ghost btn-xs"
                          onClick={() => startEditMember(member)}
                        >
                          Groups
                        </button>
                      )}
                      {canRemove && (
                        <button
                          className="icon-btn danger-hover"
                          title="Remove member"
                          onClick={() => kick(member)}
                          disabled={busy === `kick-${member.id}`}
                        >
                          {busy === `kick-${member.id}` ? (
                            <Loader2 size={15} className="spin" />
                          ) : (
                            <UserMinus size={16} />
                          )}
                        </button>
                      )}
                    </div>
                  </div>
                  {editing && (
                    <div className="member-group-editor">
                      <div className="member-group-editor-head">
                        <span>Assign groups</span>
                        <button className="icon-btn" onClick={cancelEditMember} title="Cancel">
                          <X size={15} />
                        </button>
                      </div>
                      <div className="member-group-options">
                        {groups
                          .filter((group) => !group.isDefault)
                          .map((group) => {
                            const assignable =
                              ownerOrAdmin || group.position < highestPosition(server, me);
                            const checked = memberGroupDraft.includes(group.id);
                            return (
                              <label
                                className={`member-group-option ${checked ? 'checked' : ''} ${
                                  assignable ? '' : 'disabled'
                                }`}
                                key={group.id}
                              >
                                <input
                                  type="checkbox"
                                  checked={checked}
                                  onChange={() => toggleMemberGroup(group.id)}
                                  disabled={!assignable}
                                />
                                <span
                                  className="group-color-dot"
                                  style={{ background: group.color }}
                                />
                                <span>{group.name}</span>
                              </label>
                            );
                          })}
                        {groups.filter((group) => !group.isDefault).length === 0 && (
                          <p className="member-group-empty">Create a group first.</p>
                        )}
                      </div>
                      <div className="member-group-editor-actions">
                        <button className="btn btn-ghost btn-sm" onClick={cancelEditMember}>
                          Cancel
                        </button>
                        <button
                          className="btn btn-primary btn-sm"
                          onClick={() => saveMemberGroups(member)}
                          disabled={busy === `member-groups-${member.id}`}
                        >
                          {busy === `member-groups-${member.id}` ? (
                            <Loader2 size={15} className="spin" />
                          ) : (
                            <Save size={15} />
                          )}
                          Save groups
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {tab === 'automod' && (
        <AutomodSettings server={server} canManage={canManageServer} />
      )}

      {tab === 'data' && (
        <div className="server-settings">
          <ServerDataSettings
            server={server}
            me={me}
            canExport={canManageServer}
            canImport={canImportData}
            onUpdated={onUpdated}
          />
        </div>
      )}

      {showInvites && (
        <Suspense fallback={null}>
          <InviteManager server={server} onClose={() => setShowInvites(false)} />
        </Suspense>
      )}
      {cropFile && (
        <ServerIconCropModal
          file={cropFile}
          onClose={() => busy !== 'icon-upload' && setCropFile(null)}
          onApply={applyCrop}
        />
      )}
    </div>
  );
}
