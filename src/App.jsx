import React, { useState, useEffect, createContext, useContext } from "react";
import {
  Send,
  CheckCircle,
  ArrowLeft,
  Plus,
  Trash2,
  UserMinus,
  LogOut,
  Mail,
  Copy,
  Check,
  Download
} from "lucide-react";
import {
  createGroup,
  deleteGroupCascade,
  getMemberIdentityFromInvites,
  getUserProfile,
  listGroupInvitations,
  listGroupFeedbackForRecipient,
  listGroupResponses,
  listHostedGroups,
  listMemberGroups,
  redeemInvitationForUser,
  submitGroupResponse,
  updateGroupMembers,
  upsertUserProfile
} from "./db";
import { supabase, supabaseInitError } from "./supabase";

const AnonymousIcon = ({ className = "" }) => {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <circle cx="12" cy="9" r="4" stroke="currentColor" strokeWidth="2" />
      <path
        d="M4 21c1.6-4 5-6 8-6s6.4 2 8 6"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
      <rect x="7" y="8" width="10" height="3" rx="1.25" fill="currentColor" />
    </svg>
  );
};

// ============================================================================
// CONTEXT & STATE MANAGEMENT
// ============================================================================

const AuthContext = createContext(null);

const useAuth = () => {
  const context = useContext(AuthContext);
  if (!context) throw new Error("useAuth must be used within AuthProvider");
  return context;
};

const AuthProvider = ({ children }) => {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);

  const setCurrentUser = ({ authUser, role, firstName, emailLowerOverride }) => {
    const email = authUser.email || (emailLowerOverride ? String(emailLowerOverride) : "");
    setUser({
      uid: authUser.id,
      email,
      emailLower: emailLowerOverride ? String(emailLowerOverride).toLowerCase() : String(email).toLowerCase(),
      firstName: String(firstName || "").trim(),
      isHost: role === "host"
    });
  };

  useEffect(() => {
    if (supabaseInitError || !supabase) {
      setUser(null);
      setLoading(false);
      return;
    }

    let cancelled = false;

    const applySession = (session) => {
      const authUser = session?.user;
      if (!authUser) {
        setUser(null);
        setLoading(false);
        return;
      }

      const authEmail = authUser.email || "";
      const emailLowerFromAuth = authEmail ? String(authEmail).toLowerCase() : "";
      const emailLowerFromMetadata = String(authUser.user_metadata?.email_lower || "").toLowerCase();
      const emailLower = emailLowerFromAuth || emailLowerFromMetadata;
      const fallbackFirstName =
        authUser.user_metadata?.first_name || (emailLower ? emailLower.split("@")[0] : "Anonymous");

      setUser({
        uid: authUser.id,
        email: authEmail || emailLower,
        emailLower,
        firstName: fallbackFirstName,
        isHost: false
      });
      setLoading(false);

      const profileTimeoutMs = 2500;
      const profilePromise = (async () => {
        try {
          return await getUserProfile({ uid: authUser.id });
        } catch {
          return null;
        }
      })();

      const timeoutPromise = new Promise((resolve) => setTimeout(() => resolve(null), profileTimeoutMs));

      Promise.race([profilePromise, timeoutPromise]).then((profile) => {
        if (cancelled) return;

        if (profile) {
          setUser((prev) => {
            if (!prev || prev.uid !== authUser.id) return prev;
            return {
              ...prev,
              email: prev.email || profile.emailLower || prev.email,
              emailLower: prev.emailLower || profile.emailLower || prev.emailLower,
              firstName: profile.firstName || prev.firstName,
              isHost: profile.role === "host"
            };
          });
          return;
        }

        if (emailLower) return;

        const inviteTimeoutMs = 2500;
        const invitePromise = (async () => {
          try {
            return await getMemberIdentityFromInvites({ uid: authUser.id });
          } catch {
            return null;
          }
        })();
        const inviteTimeout = new Promise((resolve) => setTimeout(() => resolve(null), inviteTimeoutMs));

        void Promise.race([invitePromise, inviteTimeout]).then((identity) => {
          if (cancelled || !identity) return;
          setUser((prev) => {
            if (!prev || prev.uid !== authUser.id) return prev;
            return {
              ...prev,
              email: prev.email || identity.emailLower,
              emailLower: prev.emailLower || identity.emailLower,
              firstName: identity.firstName || prev.firstName
            };
          });
        });
      });
    };

    supabase.auth
      .getSession()
      .then(({ data }) => {
        if (cancelled) return;
        applySession(data.session);
      })
      .catch(() => {
        if (cancelled) return;
        setUser(null);
        setLoading(false);
      });

    const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => {
      if (cancelled) return;
      applySession(session);
    });

    return () => {
      cancelled = true;
      sub?.subscription?.unsubscribe();
    };
  }, []);

  const signup = async (email, password, firstName) => {
    const emailLower = String(email || "").trim().toLowerCase();
    const displayName = String(firstName || "").trim();
    try {
      const { data, error } = await supabase.auth.signUp({
        email: emailLower,
        password,
        options: { data: { first_name: displayName } }
      });
      if (error) {
        const m = String(error.message || "").toLowerCase();
        if (m.includes("email confirmation")) {
          throw new Error("Disable email confirmation in Supabase Auth, then try again.");
        }
        throw error;
      }
      if (!data.session) throw new Error("Disable email confirmation in Supabase Auth, then try again.");
      await upsertUserProfile({ uid: data.session.user.id, emailLower, firstName: displayName, role: "host" });
      setCurrentUser({ authUser: data.session.user, role: "host", firstName: displayName });
    } catch (err) {
      const message = String(err?.message || "");
      if (message.toLowerCase().includes("already") || message.toLowerCase().includes("registered")) {
        const { data, error } = await supabase.auth.signInWithPassword({ email: emailLower, password });
        if (error) throw error;
        await upsertUserProfile({ uid: data.user.id, emailLower, firstName: displayName, role: "host" });
        setCurrentUser({ authUser: data.user, role: "host", firstName: displayName });
      } else {
        throw err;
      }
    }
  };

  const login = async (email, password) => {
    const emailLower = String(email || "").trim().toLowerCase();
    const { data, error } = await supabase.auth.signInWithPassword({
      email: emailLower,
      password: String(password || "")
    });
    if (error) throw error;

    const authUser = data.user;
    let role = "member";
    let firstName = authUser.user_metadata?.first_name || (emailLower ? emailLower.split("@")[0] : "Anonymous");
    let emailLowerOverride = emailLower;

    try {
      const profile = await getUserProfile({ uid: authUser.id });
      if (profile) {
        role = profile.role || role;
        firstName = profile.firstName || firstName;
        emailLowerOverride = profile.emailLower || emailLowerOverride;
      }
    } catch {
      // ignore
    }

    setCurrentUser({ authUser, role, firstName, emailLowerOverride });
  };

  const loginWithInvite = async (email, tempPassword) => {
    const emailLower = String(email || "").trim().toLowerCase();
    const password = String(tempPassword || "").trim();

    try {
      try {
        await supabase.auth.signOut();
      } catch {
        // ignore
      }

      const { data: anonData, error: anonError } = await supabase.auth.signInAnonymously();
      if (anonError) {
        const msg = String(anonError.message || "").toLowerCase();
        if (msg.includes("anonymous") && msg.includes("disabled")) {
          throw new Error("Enable Anonymous sign-ins in Supabase Auth settings, then try again.");
        }
        throw anonError;
      }

      const authUser = anonData.user;

      const invite = await redeemInvitationForUser({ uid: authUser.id, emailLower, tempPassword: password });

      try {
        await supabase.auth.updateUser({
          data: {
            email_lower: invite.emailLower,
            first_name: invite.name,
            role: "member"
          }
        });
      } catch {
        // ignore
      }

      setCurrentUser({ authUser, role: "member", firstName: invite.name, emailLowerOverride: invite.emailLower });
      return invite;
    } catch (err) {
      await supabase.auth.signOut();
      throw err;
    }
  };

  const logout = () => {
    return supabase.auth.signOut();
  };

  return (
    <AuthContext.Provider value={{ user, signup, login, loginWithInvite, logout, loading }}>
      {children}
    </AuthContext.Provider>
  );
};

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

const generateTempPassword = () => {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  return Array.from({ length: 6 }, () => chars[Math.floor(Math.random() * chars.length)]).join(
    ""
  );
};

// ============================================================================
// UI COMPONENTS
// ============================================================================

const Button = ({ children, variant = "primary", className = "", ...props }) => {
  const baseClass =
    "px-6 py-3 rounded-lg font-medium transition-all duration-200 flex items-center gap-2 justify-center";
  const variants = {
    primary: "bg-purple-600 hover:bg-purple-700 text-white shadow-lg hover:shadow-xl",
    secondary: "bg-gray-700 hover:bg-gray-600 text-white",
    ghost: "bg-transparent hover:bg-gray-800 text-gray-300",
    danger: "bg-red-600 hover:bg-red-700 text-white"
  };

  return (
    <button
      className={`${baseClass} ${variants[variant]} ${className} disabled:opacity-50 disabled:cursor-not-allowed`}
      {...props}
    >
      {children}
    </button>
  );
};

const Card = ({ children, className = "", ...props }) => {
  return (
    <div
      className={`bg-gray-800 rounded-xl p-6 shadow-xl border border-gray-700 ${className}`}
      {...props}
    >
      {children}
    </div>
  );
};

const Input = ({ label, error, ...props }) => {
  return (
    <div className="space-y-2">
      {label && <label className="block text-sm font-medium text-gray-300">{label}</label>}
      <input
        className="w-full px-4 py-3 bg-gray-700 border border-gray-600 rounded-lg text-white placeholder-gray-400 focus:ring-2 focus:ring-purple-500 focus:border-transparent transition"
        {...props}
      />
      {error && <p className="text-red-400 text-sm">{error}</p>}
    </div>
  );
};

const Textarea = ({ label, error, ...props }) => {
  return (
    <div className="space-y-2">
      {label && <label className="block text-sm font-medium text-gray-300">{label}</label>}
      <textarea
        className="w-full px-4 py-3 bg-gray-700 border border-gray-600 rounded-lg text-white placeholder-gray-400 focus:ring-2 focus:ring-purple-500 focus:border-transparent transition resize-none"
        rows={4}
        {...props}
      />
      {error && <p className="text-red-400 text-sm">{error}</p>}
    </div>
  );
};

// ============================================================================
// AUTH SCREEN
// ============================================================================

const AuthScreen = () => {
  const [isHost, setIsHost] = useState(true);
  const [joinMode, setJoinMode] = useState("invite"); // invite | signin
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [firstName, setFirstName] = useState("");
  const [tempPassword, setTempPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const { signup, login, loginWithInvite } = useAuth();

  const handleHostSignup = async () => {
    setError("");

    if (!email || !password || !firstName) {
      setError("Please fill in all fields");
      return;
    }

	    setLoading(true);
	    try {
	      await signup(email, password, firstName);
	    } catch (err) {
	      setError(err?.message || "Something went wrong. Please try again.");
	    } finally {
	      setLoading(false);
	    }
		  };

  const handleAccountLogin = async () => {
    setError("");

    if (!email || !password) {
      setError("Please enter your email and password");
      return;
    }

    setLoading(true);
    try {
      await login(email, password);
    } catch (err) {
      setError(err?.message || "Invalid credentials");
    } finally {
      setLoading(false);
    }
  };

  const handleMemberLogin = async () => {
    setError("");

    if (!email || !tempPassword) {
      setError("Please enter your email and temporary password");
      return;
    }

    setLoading(true);
    try {
      await loginWithInvite(email, tempPassword);
    } catch (err) {
      setError(err?.message || "Invalid credentials");
    } finally {
      setLoading(false);
    }
  };

  const handleKeyDown = (e) => {
    if (e.key === "Enter") {
      if (isHost) return handleHostSignup();
      return joinMode === "invite" ? handleMemberLogin() : handleAccountLogin();
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-gray-900 via-purple-900 to-gray-900 flex items-center justify-center p-4">
      <Card className="w-full max-w-md">
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-16 h-16 bg-purple-600 rounded-full mb-4">
            <AnonymousIcon className="w-8 h-8 text-white" />
          </div>
          <h1 className="text-3xl font-bold text-white mb-2">OffRecord</h1>
          <p className="text-gray-400">Anonymous peer feedback for growth</p>
        </div>

        <div className="flex gap-2 mb-6 bg-gray-700 p-1 rounded-lg">
          <button
            onClick={() => setIsHost(true)}
            className={`flex-1 py-2 rounded-md transition ${
              isHost ? "bg-purple-600 text-white" : "text-gray-400"
            }`}
          >
            Create Group
          </button>
          <button
            onClick={() => setIsHost(false)}
            className={`flex-1 py-2 rounded-md transition ${
              !isHost ? "bg-purple-600 text-white" : "text-gray-400"
            }`}
          >
            Join Group
          </button>
        </div>

        {isHost ? (
          <div className="space-y-4">
            <Input
              label="First Name"
              type="text"
              placeholder="Alex"
              value={firstName}
              onChange={(e) => setFirstName(e.target.value)}
              onKeyDown={handleKeyDown}
            />

            <Input
              label="Email"
              type="email"
              placeholder="you@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              onKeyDown={handleKeyDown}
            />

            <Input
              label="Password"
              type="password"
              placeholder="••••••••"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              onKeyDown={handleKeyDown}
            />

            {error && (
              <div className="bg-red-900/30 border border-red-500 rounded-lg p-3 text-red-400 text-sm">
                {error}
              </div>
            )}

            <Button onClick={handleHostSignup} variant="primary" className="w-full" disabled={loading}>
              {loading ? "Please wait..." : "Create Account"}
            </Button>

            <p className="text-sm text-gray-400 text-center">
              You'll be able to create groups and invite members
            </p>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="flex gap-2 mb-1 bg-gray-700 p-1 rounded-lg">
              <button
                onClick={() => setJoinMode("invite")}
                className={`flex-1 py-2 rounded-md transition ${
                  joinMode === "invite" ? "bg-purple-600 text-white" : "text-gray-400"
                }`}
              >
                Invite Code
              </button>
              <button
                onClick={() => setJoinMode("signin")}
                className={`flex-1 py-2 rounded-md transition ${
                  joinMode === "signin" ? "bg-purple-600 text-white" : "text-gray-400"
                }`}
              >
                Sign In
              </button>
            </div>

            <Input
              label="Email"
              type="email"
              placeholder="The email you were invited with"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              onKeyDown={handleKeyDown}
            />

            {joinMode === "invite" ? (
              <Input
                label="Temporary Password"
                type="text"
                placeholder="ABC123"
                value={tempPassword}
                onChange={(e) => setTempPassword(e.target.value.toUpperCase())}
                onKeyDown={handleKeyDown}
              />
            ) : (
              <Input
                label="Password"
                type="password"
                placeholder="••••••••"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                onKeyDown={handleKeyDown}
              />
            )}

            {error && (
              <div className="bg-red-900/30 border border-red-500 rounded-lg p-3 text-red-400 text-sm">
                {error}
              </div>
            )}

            <Button
              onClick={joinMode === "invite" ? handleMemberLogin : handleAccountLogin}
              variant="primary"
              className="w-full"
              disabled={loading}
            >
              {loading ? "Please wait..." : joinMode === "invite" ? "Join Group" : "Sign In"}
            </Button>

            <p className="text-sm text-gray-400 text-center">
              {joinMode === "invite"
                ? "No account needed — use the invite credentials from your host"
                : "Use your existing OffRecord account"}
            </p>
          </div>
        )}
      </Card>
    </div>
  );
};

// ============================================================================
// DASHBOARD
// ============================================================================

const Dashboard = () => {
  const { user, logout } = useAuth();
  const [groups, setGroups] = useState([]);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [loadingGroups, setLoadingGroups] = useState(true);
  const [groupsError, setGroupsError] = useState("");
  const [loadingSlow, setLoadingSlow] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const withTimeout = (promise, ms) => {
    return Promise.race([
      promise,
      new Promise((_, reject) => setTimeout(() => reject(new Error("Timed out loading groups")), ms))
    ]);
  };

  useEffect(() => {
    const load = async () => {
      setGroupsError("");
      setLoadingGroups(true);
      setLoadingSlow(false);
      try {
        const slowTimer = setTimeout(() => setLoadingSlow(true), 2500);
        const timeoutMs = 15000;

        const hostedPromise = withTimeout(listHostedGroups({ hostUid: user.uid }), timeoutMs);
        const memberPromise = withTimeout(listMemberGroups({ uid: user.uid, emailLower: user.emailLower }), timeoutMs);

        const [hostedRes, memberRes] = await Promise.allSettled([hostedPromise, memberPromise]);
        clearTimeout(slowTimer);

        const merged = [];
        const seen = new Set();
        for (const res of [hostedRes, memberRes]) {
          if (res.status !== "fulfilled") continue;
          for (const g of res.value || []) {
            if (seen.has(g.id)) continue;
            seen.add(g.id);
            merged.push(g);
          }
        }

        if (merged.length === 0 && hostedRes.status === "rejected" && memberRes.status === "rejected") {
          throw hostedRes.reason || memberRes.reason || new Error("Failed to load groups");
        }

        setGroups(merged);
      } catch (err) {
        setGroupsError(err?.message || "Failed to load groups");
      } finally {
        setLoadingGroups(false);
      }
    };

    void load();
  }, [user.emailLower, user.uid]);

  const refreshGroups = async () => {
    setGroupsError("");
    setLoadingGroups(true);
    setLoadingSlow(false);
    setRefreshing(true);
    try {
      const slowTimer = setTimeout(() => setLoadingSlow(true), 2500);
      const timeoutMs = 15000;

      const hostedPromise = withTimeout(listHostedGroups({ hostUid: user.uid }), timeoutMs);
      const memberPromise = withTimeout(listMemberGroups({ uid: user.uid, emailLower: user.emailLower }), timeoutMs);

      const [hostedRes, memberRes] = await Promise.allSettled([hostedPromise, memberPromise]);
      clearTimeout(slowTimer);

      const merged = [];
      const seen = new Set();
      for (const res of [hostedRes, memberRes]) {
        if (res.status !== "fulfilled") continue;
        for (const g of res.value || []) {
          if (seen.has(g.id)) continue;
          seen.add(g.id);
          merged.push(g);
        }
      }

      if (merged.length === 0 && hostedRes.status === "rejected" && memberRes.status === "rejected") {
        throw hostedRes.reason || memberRes.reason || new Error("Failed to load groups");
      }

      setGroups(merged);
    } catch (err) {
      setGroupsError(err?.message || "Failed to load groups");
    } finally {
      setLoadingGroups(false);
      setRefreshing(false);
    }
  };

  return (
    <div className="min-h-screen bg-gray-900">
      <header className="bg-gray-800 border-b border-gray-700">
        <div className="max-w-6xl mx-auto px-4 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-purple-600 rounded-full flex items-center justify-center">
              <AnonymousIcon className="w-5 h-5 text-white" />
            </div>
            <div>
              <h1 className="text-xl font-bold text-white">OffRecord</h1>
              <p className="text-sm text-gray-400">
                Welcome, {user.firstName}
                {user.isHost && <span className="ml-2 text-purple-400">(Host)</span>}
              </p>
            </div>
          </div>

          <button onClick={logout} className="flex items-center gap-2 text-gray-400 hover:text-white transition">
            <LogOut className="w-5 h-5" />
            <span className="text-sm">Sign out</span>
          </button>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-4 py-8">
        <div className="flex items-center justify-between mb-8">
          <div>
            <h2 className="text-2xl font-bold text-white mb-1">
              {user.isHost ? "Your Groups" : "Your Feedback Groups"}
            </h2>
            <p className="text-gray-400">
              {user.isHost ? "Create groups and invite members" : "Complete surveys to give feedback"}
            </p>
          </div>
          <div className="flex items-center gap-3">
            <Button variant="secondary" onClick={refreshGroups} disabled={loadingGroups}>
              {refreshing ? "Refreshing..." : "Refresh"}
            </Button>
            {user.isHost && (
              <Button onClick={() => setShowCreateModal(true)} disabled={loadingGroups}>
                <Plus className="w-5 h-5" />
                New Group
              </Button>
            )}
          </div>
        </div>

        {groups.length === 0 ? (
          <Card className="text-center py-12">
            <AnonymousIcon className="w-16 h-16 text-gray-600 mx-auto mb-4" />
            <h3 className="text-xl font-semibold text-white mb-2">
              {loadingGroups ? "Loading..." : user.isHost ? "No groups yet" : "No invitations yet"}
            </h3>
            {groupsError ? (
              <p className="text-red-400 mb-6">{groupsError}</p>
            ) : (
              <p className="text-gray-400 mb-6">
                {loadingGroups
                  ? loadingSlow
                    ? "Still fetching your groups… (this is usually a network issue)"
                    : "Fetching your groups..."
                  : user.isHost
                    ? "Create your first feedback group to get started"
                    : "Wait for a group host to invite you"}
              </p>
            )}
            {user.isHost && (
              <Button onClick={() => setShowCreateModal(true)}>
                <Plus className="w-5 h-5" />
                Create Group
              </Button>
            )}
          </Card>
        ) : (
          <div className="grid gap-6 md:grid-cols-2">
            {groups.map((group) => (
              <GroupCard
                key={group.id}
                group={group}
                onRefresh={refreshGroups}
                onDelete={async (id) => {
                  await deleteGroupCascade({ groupId: id });
                  await refreshGroups();
                }}
              />
            ))}
          </div>
        )}
      </main>

      {showCreateModal && (
        <CreateGroupModal
          hostUid={user.uid}
          hostEmail={user.email}
          hostName={user.firstName}
          onClose={() => setShowCreateModal(false)}
          onCreated={async () => {
            await refreshGroups();
          }}
        />
      )}
    </div>
  );
};

const GroupCard = ({ group, onDelete, onRefresh }) => {
  const { user } = useAuth();
  const [showSurvey, setShowSurvey] = useState(false);
  const [showInvites, setShowInvites] = useState(false);
  const [showPDFModal, setShowPDFModal] = useState(false);
  const [statusNonce, setStatusNonce] = useState(0);
  const [removingSelf, setRemovingSelf] = useState(false);
  const [status, setStatus] = useState({
    loading: true,
    completed: 0,
    total: group.members?.length || 0,
    userHasSubmitted: false,
    userIsParticipant: false,
    isComplete: false
  });

  useEffect(() => {
    let cancelled = false;

    const loadStatus = async () => {
      try {
        const submissions = await listGroupResponses({ groupId: group.id });
        const respondents = new Set((submissions || []).map((s) => s.respondentUid).filter(Boolean));

        const members = group.members || [];
        const total = members.length;
        const completed = respondents.size;
        const userIsParticipant = members.some((m) => String(m.emailLower || "").toLowerCase() === user.emailLower);
        const userHasSubmitted = respondents.has(user.uid);

        if (!cancelled) {
          setStatus({
            loading: false,
            completed,
            total,
            userHasSubmitted,
            userIsParticipant,
            isComplete: total > 0 && completed === total
          });
        }
      } catch {
        if (!cancelled) {
          setStatus((s) => ({ ...s, loading: false }));
        }
      }
    };

    void loadStatus();
    return () => {
      cancelled = true;
    };
  }, [group.id, group.memberEmails, group.members, user.emailLower, statusNonce]);

  const getStatusBadge = () => {
    if (status.loading) {
      return (
        <div className="text-gray-400">
          <span className="text-sm font-medium">Loading status…</span>
        </div>
      );
    }
    if (status.isComplete) {
      return (
        <div className="flex items-center gap-2 text-green-400">
          <CheckCircle className="w-5 h-5" />
          <span className="text-sm font-medium">Completed</span>
        </div>
      );
    }
    if (!status.userIsParticipant) {
      return (
        <div className="text-gray-400">
          <span className="text-sm font-medium">
            Collecting feedback ({status.completed}/{status.total})
          </span>
        </div>
      );
    }
    if (status.userHasSubmitted) {
      return (
        <div className="text-yellow-400">
          <span className="text-sm font-medium">
            Waiting for others ({status.completed}/{status.total})
          </span>
        </div>
      );
    }
    return (
      <div className="text-purple-400">
        <span className="text-sm font-medium">Action needed</span>
      </div>
    );
  };

  const getActionButton = () => {
    if (status.isComplete) {
      if (!status.userIsParticipant) {
        return (
          <Button variant="ghost" disabled>
            All feedback collected
          </Button>
        );
      }
      return (
        <Button onClick={() => setShowPDFModal(true)}>
          <Download className="w-5 h-5" />
          Download Feedback
        </Button>
      );
    }
    if (status.loading) {
      return (
        <Button variant="ghost" disabled>
          Loading…
        </Button>
      );
    }
    if (!status.userIsParticipant) {
      return (
        <Button variant="ghost" disabled>
          Waiting for responses
        </Button>
      );
    }
    if (status.userHasSubmitted) {
      return (
        <Button variant="ghost" disabled>
          Response submitted
        </Button>
      );
    }
    return <Button onClick={() => setShowSurvey(true)}>Give Feedback</Button>;
  };

  if (showSurvey) {
    return (
      <SurveyScreen
        group={group}
        onComplete={() => {
          setShowSurvey(false);
          setStatus((s) => ({ ...s, loading: true }));
          setStatusNonce((n) => n + 1);
          void onRefresh?.();
        }}
      />
    );
  }

  if (showInvites) {
    return <InvitationModal group={group} onClose={() => setShowInvites(false)} />;
  }

  if (showPDFModal) {
    return (
      <FeedbackPDFModal
        group={group}
        userEmail={user.emailLower}
        userName={user.firstName}
        onClose={() => setShowPDFModal(false)}
      />
    );
  }

  return (
    <Card>
      <div className="flex items-start justify-between mb-4">
        <div className="flex-1">
          <h3 className="text-xl font-semibold text-white mb-2">{group.name}</h3>
          <p className="text-gray-400 text-sm">{group.members?.length || 0} members</p>
        </div>
        <div className="flex gap-2">
          {user.isHost && !status.isComplete && (
            <button
              onClick={() => setShowInvites(true)}
              className="text-gray-500 hover:text-purple-400 transition"
              title="View Invitations"
            >
              <Mail className="w-5 h-5" />
            </button>
          )}
          {user.isHost && status.userIsParticipant && (
            <button
              onClick={async () => {
                if (removingSelf) return;
                const ok = window.confirm(
                  "Remove yourself from this group's member list? You can still manage the group as host."
                );
                if (!ok) return;

                setRemovingSelf(true);
                try {
                  const remaining = (group.members || []).filter(
                    (m) => String(m.emailLower || "").toLowerCase() !== user.emailLower
                  );
                  await updateGroupMembers({ groupId: group.id, members: remaining });
                  setStatusNonce((n) => n + 1);
                  await onRefresh?.();
                } catch (err) {
                  alert(err?.message || "Failed to update members");
                } finally {
                  setRemovingSelf(false);
                }
              }}
              className="text-gray-500 hover:text-yellow-400 transition disabled:opacity-40 disabled:cursor-not-allowed"
              title="Remove me from members"
              disabled={removingSelf}
            >
              <UserMinus className="w-5 h-5" />
            </button>
          )}
          {user.isHost && !status.isComplete && (
            <button onClick={() => onDelete(group.id)} className="text-gray-500 hover:text-red-400 transition">
              <Trash2 className="w-5 h-5" />
            </button>
          )}
        </div>
      </div>

      <div className="mb-4">{getStatusBadge()}</div>

      <div className="mb-4">
        <div className="flex items-center justify-between text-sm text-gray-400 mb-2">
          <span>Progress</span>
          <span>
            {status.completed}/{status.total}
          </span>
        </div>
        <div className="w-full bg-gray-700 rounded-full h-2">
          <div
            className="bg-purple-600 h-2 rounded-full transition-all duration-500"
            style={{ width: `${status.total > 0 ? (status.completed / status.total) * 100 : 0}%` }}
          />
        </div>
      </div>

      <div className="flex flex-wrap gap-2 mb-4">
        {(group.members || []).map((member, idx) => (
          <span key={idx} className="px-3 py-1 bg-gray-700 rounded-full text-sm text-gray-300">
            {member.name}
          </span>
        ))}
      </div>

      {getActionButton()}
    </Card>
  );
};

// ============================================================================
// CREATE GROUP MODAL
// ============================================================================

const CreateGroupModal = ({ hostUid, hostEmail, hostName, onClose, onCreated }) => {
  const [step, setStep] = useState(1);
  const [groupName, setGroupName] = useState("");
  const [createdInvitations, setCreatedInvitations] = useState([]);
  const [members, setMembers] = useState([{ email: "", name: "" }]);
  const [error, setError] = useState("");
  const [creating, setCreating] = useState(false);

  const addMember = () => {
    if (members.length < 10) {
      setMembers([...members, { email: "", name: "" }]);
    }
  };

  const removeMember = (idx) => {
    if (members.length > 1) {
      setMembers(members.filter((_, i) => i !== idx));
    }
  };

  const updateMember = (idx, field, value) => {
    const updated = [...members];
    updated[idx] = { ...updated[idx], [field]: value };
    setMembers(updated);
  };

  const handleCreate = async () => {
    setError("");

    if (!groupName.trim()) {
      setError("Please enter a group name");
      return;
    }

    const validMembers = members.filter((m) => m.email.trim() && m.name.trim());

    const hostEmailLower = String(hostEmail || "").trim().toLowerCase();
    const emails = validMembers.map((m) => m.email.toLowerCase());
    if (hostEmailLower && emails.includes(hostEmailLower)) {
      setError("You’re already included — don’t add your own email again");
      return;
    }
    if (new Set(emails).size !== emails.length) {
      setError("Each member must have a unique email");
      return;
    }

    setCreating(true);
    try {
      const membersWithPasswords = validMembers.map((m) => ({
        email: m.email.toLowerCase(),
        name: m.name.trim(),
        tempPassword: generateTempPassword()
      }));

      const result = await createGroup({
        name: groupName,
        hostUid,
        hostEmail,
        hostName,
        members: membersWithPasswords
      });

      setCreatedInvitations(
        result.invitations.map((i) => ({
          email: i.emailLower,
          name: i.name,
          tempPassword: i.tempPassword
        }))
      );
      setStep(3);
      await onCreated(result.group);
    } catch (err) {
      setError(err?.message || "Failed to create group");
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center p-4 z-50 overflow-y-auto">
      <Card className="w-full max-w-3xl my-8">
        <div className="flex items-center justify-between mb-6">
          <h2 className="text-2xl font-bold text-white">Create Feedback Group</h2>
          {step !== 3 && (
            <button onClick={onClose} className="text-gray-400 hover:text-white text-2xl leading-none">
              ×
            </button>
          )}
        </div>

        {step === 1 && (
          <div className="space-y-6">
            <Input
              label="What's this group for?"
              placeholder="Q4 Product Team Retro"
              value={groupName}
              onChange={(e) => setGroupName(e.target.value)}
            />

            <div className="text-center">
              <Button onClick={() => setStep(2)} disabled={!groupName.trim()}>
                Continue
              </Button>
            </div>
          </div>
        )}

        {step === 2 && (
          <div className="space-y-6">
            <div>
              <label className="block text-sm font-medium text-gray-300 mb-3">Members (email + name)</label>

              <div className="space-y-3">
                <div className="flex gap-2 opacity-90">
                  <input
                    className="flex-1 px-4 py-3 bg-gray-700 border border-gray-600 rounded-lg text-white placeholder-gray-400"
                    value={String(hostEmail || "").toLowerCase()}
                    disabled
                  />
                  <input
                    className="flex-1 px-4 py-3 bg-gray-700 border border-gray-600 rounded-lg text-white placeholder-gray-400"
                    value={String(hostName || "").trim()}
                    disabled
                  />
                  <div className="px-4 py-3 rounded-lg bg-gray-900/30 border border-gray-700 text-gray-400 text-sm flex items-center">
                    Host
                  </div>
                </div>
                {members.map((member, idx) => (
                  <div key={idx} className="flex gap-2">
                    <input
                      className="flex-1 px-4 py-3 bg-gray-700 border border-gray-600 rounded-lg text-white placeholder-gray-400 focus:ring-2 focus:ring-purple-500 focus:border-transparent"
                      placeholder="email@example.com"
                      type="email"
                      value={member.email}
                      onChange={(e) => updateMember(idx, "email", e.target.value)}
                    />
                    <input
                      className="flex-1 px-4 py-3 bg-gray-700 border border-gray-600 rounded-lg text-white placeholder-gray-400 focus:ring-2 focus:ring-purple-500 focus:border-transparent"
                      placeholder="Full Name"
                      value={member.name}
                      onChange={(e) => updateMember(idx, "name", e.target.value)}
                    />
                    {members.length > 1 && (
                      <button
                        onClick={() => removeMember(idx)}
                        className="px-4 py-3 bg-red-900/30 border border-red-500 rounded-lg text-red-400 hover:bg-red-900/50 transition"
                      >
                        <Trash2 className="w-5 h-5" />
                      </button>
                    )}
                  </div>
                ))}
              </div>

              {members.length < 10 && (
                <button onClick={addMember} className="mt-3 text-purple-400 hover:text-purple-300 text-sm flex items-center gap-2">
                  <Plus className="w-4 h-4" />
                  Add member
                </button>
              )}

              <p className="mt-4 text-sm text-gray-400">
                💡 3-6 people work best. You'll copy/share invite credentials after creating the group.
              </p>
            </div>

            {error && (
              <div className="bg-red-900/30 border border-red-500 rounded-lg p-3 text-red-400 text-sm">{error}</div>
            )}

            <div className="flex gap-3">
              <Button variant="secondary" onClick={() => setStep(1)}>
                Back
              </Button>
              <Button onClick={handleCreate} className="flex-1" disabled={creating}>
                {creating ? "Creating..." : "Create Group & Send Invites"}
              </Button>
            </div>
          </div>
        )}

        {step === 3 && (
          <InvitationSuccess
            groupName={groupName}
            invitations={createdInvitations}
            onClose={() => onClose()}
          />
        )}
      </Card>
    </div>
  );
};

// ============================================================================
// INVITATION SUCCESS SCREEN
// ============================================================================

const InvitationSuccess = ({ groupName, invitations, onClose }) => {
  return (
    <div className="space-y-6">
      <div className="text-center">
        <div className="w-20 h-20 bg-green-500 rounded-full flex items-center justify-center mx-auto mb-4">
          <CheckCircle className="w-12 h-12 text-white" />
        </div>
        <h3 className="text-2xl font-bold text-white mb-2">Group Created!</h3>
        <p className="text-gray-400">Invitations ready to send for {groupName}</p>
      </div>

      <div className="bg-gray-700/50 rounded-lg p-4">
        <h4 className="text-sm font-semibold text-white mb-3">Send these credentials to your members:</h4>
        <div className="space-y-3">
          {invitations.map((invite, idx) => (
            <InviteCredentials key={idx} invite={invite} />
          ))}
        </div>
      </div>

      <div className="bg-yellow-900/20 border border-yellow-600 rounded-lg p-4">
        <p className="text-yellow-300 text-sm">
          ⚠️ Save these temporary passwords! Members will need them to sign in and complete their feedback.
        </p>
      </div>

      <Button onClick={onClose} className="w-full">
        Done
      </Button>
    </div>
  );
};

const InviteCredentials = ({ invite }) => {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    const appUrl = window.location.origin;
    const copyText =
      "Hi " +
      invite.name +
      ",\n\nYou have been invited to give feedback in a group.\n\nSign in at: " +
      appUrl +
      "\nEmail: " +
      invite.email +
      "\nTemporary Password: " +
      invite.tempPassword +
      "\n\nComplete your survey to help your team grow!";
    navigator.clipboard.writeText(copyText);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  if (!invite) return null;

  return (
    <div className="bg-gray-800 rounded-lg p-3 flex items-center justify-between">
      <div className="flex-1">
        <p className="text-white font-medium text-sm">{invite.name}</p>
        <p className="text-gray-400 text-xs">{invite.email}</p>
        <p className="text-purple-400 font-mono text-sm mt-1">Password: {invite.tempPassword}</p>
      </div>
      <button onClick={handleCopy} className="px-3 py-2 bg-purple-600 hover:bg-purple-700 rounded-lg transition flex items-center gap-2">
        {copied ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
        <span className="text-xs">{copied ? "Copied!" : "Copy"}</span>
      </button>
    </div>
  );
};

// ============================================================================
// FEEDBACK PDF MODAL & DOWNLOAD
// ============================================================================

const FeedbackPDFModal = ({ group, userEmail, userName, onClose }) => {
  const [downloading, setDownloading] = useState(false);
  const [loadingFeedback, setLoadingFeedback] = useState(true);
  const [shuffledFeedback, setShuffledFeedback] = useState([]);

  useEffect(() => {
    let cancelled = false;

	    const loadFeedback = async () => {
	      setLoadingFeedback(true);
	      try {
	        const feedback = await listGroupFeedbackForRecipient({
	          groupId: group.id,
	          recipientEmailLower: userEmail
	        });
	        const shuffled = [...feedback].sort(() => Math.random() - 0.5);
	        if (!cancelled) setShuffledFeedback(shuffled);
	      } finally {
	        if (!cancelled) setLoadingFeedback(false);
	      }
	    };

    void loadFeedback();
    return () => {
      cancelled = true;
    };
  }, [group.id, userEmail]);

  const totalScore = shuffledFeedback.reduce((sum, f) => sum + f.score, 0);
  const averageScore = shuffledFeedback.length > 0 ? Math.round(totalScore / shuffledFeedback.length) : 0;

  const getParticipationLevel = (score) => {
    if (score >= 90) return { text: "Great Participation", color: "text-green-600", bgColor: "bg-green-50" };
    if (score >= 80) return { text: "Strong Participation", color: "text-blue-600", bgColor: "bg-blue-50" };
    if (score >= 70) return { text: "Good Participation", color: "text-purple-600", bgColor: "bg-purple-50" };
    if (score >= 60) return { text: "Moderate Participation", color: "text-yellow-600", bgColor: "bg-yellow-50" };
    return { text: "Developing Participation", color: "text-orange-600", bgColor: "bg-orange-50" };
  };

  const participationLevel = getParticipationLevel(averageScore);

  const getScoreColor = () => {
    if (averageScore >= 90) return "#059669";
    if (averageScore >= 80) return "#2563eb";
    if (averageScore >= 70) return "#9333ea";
    if (averageScore >= 60) return "#d97706";
    return "#ea580c";
  };

  const downloadPDF = () => {
    setDownloading(true);

    const pdfContent = generatePDFHTML(userName, group.name, shuffledFeedback, averageScore, participationLevel);

    const blob = new Blob([pdfContent], { type: "text/html" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `feedback-${userName.replace(/\s+/g, "-")}-${Date.now()}.html`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);

    const printWindow = window.open("", "_blank");
    if (!printWindow) {
      setDownloading(false);
      alert("Pop-up blocked. Please allow pop-ups to print/save as PDF.");
      return;
    }

    printWindow.document.write(pdfContent);
    printWindow.document.close();

    setTimeout(() => {
      printWindow.print();
      setDownloading(false);
    }, 500);
  };

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center p-4 z-50 overflow-y-auto">
      <Card className="w-full max-w-4xl my-8 max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h2 className="text-2xl font-bold text-white">Your Feedback</h2>
            <p className="text-gray-400 text-sm mt-1">From {group.name}</p>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-white text-2xl leading-none">
            ×
          </button>
        </div>

        <div className="bg-white rounded-lg p-8 mb-6 text-gray-900">
          <div className="text-center mb-8 border-b border-gray-300 pb-6">
            <h1 className="text-3xl font-bold mb-2">Feedback for {userName}</h1>
            <p className="text-gray-600">Generated {new Date().toLocaleDateString()}</p>
            <p className="text-sm text-gray-500 mt-2">From: {group.name}</p>
          </div>

          {loadingFeedback ? (
            <div className="text-center py-12">
              <p className="text-gray-500">Loading feedback…</p>
            </div>
          ) : shuffledFeedback.length === 0 ? (
            <div className="text-center py-12">
              <p className="text-gray-500">No feedback available yet</p>
            </div>
          ) : (
            <>
              <div
                className={`${participationLevel.bgColor} rounded-lg p-6 mb-8 border-2`}
                style={{ borderColor: getScoreColor() }}
              >
                <div className="text-center">
                  <div className="text-5xl font-bold mb-2" style={{ color: getScoreColor() }}>
                    {averageScore}
                  </div>
                  <div className="text-sm text-gray-600 mb-1">Average Score</div>
                  <div className={`text-lg font-semibold ${participationLevel.color}`}>{participationLevel.text}</div>
                  <div className="text-xs text-gray-500 mt-3">
                    100-90: Great • 89-80: Strong • 79-70: Good • 69-60: Moderate • Below 60: Developing
                  </div>
                </div>
              </div>

              <div className="space-y-8">
                {shuffledFeedback.map((feedback, idx) => (
                  <div key={idx} className="border-l-4 border-purple-500 pl-6 py-4">
                    <h3 className="text-lg font-bold mb-4 text-purple-900">Response {idx + 1}</h3>

                    <div className="mb-4">
                      <h4 className="font-semibold text-sm text-gray-700 mb-2">What you did well:</h4>
                      <p className="text-gray-800 leading-relaxed">{feedback.strengths}</p>
                    </div>

                    <div className="mb-4">
                      <h4 className="font-semibold text-sm text-gray-700 mb-2">What you could improve:</h4>
                      <p className="text-gray-800 leading-relaxed">{feedback.improvements}</p>
                    </div>

                    <div className="bg-purple-50 rounded px-4 py-2 inline-block">
                      <span className="font-semibold text-purple-900">Score: {feedback.score} points</span>
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}

          <div className="mt-12 pt-6 border-t border-gray-300 text-center text-sm text-gray-500">
            <p>This feedback is anonymous. No names are attached to individual responses.</p>
            <p className="mt-2">Generated by OffRecord</p>
          </div>
        </div>

        <div className="flex gap-3">
          <Button variant="secondary" onClick={onClose} className="flex-1">
            Close
          </Button>
          <Button
            onClick={downloadPDF}
            disabled={downloading || loadingFeedback || shuffledFeedback.length === 0}
            className="flex-1"
          >
            <Download className="w-5 h-5" />
            {downloading ? "Preparing..." : "Download PDF"}
          </Button>
        </div>

        <p className="text-sm text-gray-400 mt-4 text-center">
          Click "Download PDF" to print or save as PDF using your browser's print dialog
        </p>
      </Card>
    </div>
  );
};

const generatePDFHTML = (userName, groupName, feedback, averageScore, participationLevel) => {
  const escapeHtml = (value) => {
    return String(value)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
  };

  const getScoreColor = () => {
    if (averageScore >= 90) return "#059669";
    if (averageScore >= 80) return "#2563eb";
    if (averageScore >= 70) return "#9333ea";
    if (averageScore >= 60) return "#d97706";
    return "#ea580c";
  };

  const getScoreBgColor = () => {
    if (averageScore >= 90) return "#d1fae5";
    if (averageScore >= 80) return "#dbeafe";
    if (averageScore >= 70) return "#f3e8ff";
    if (averageScore >= 60) return "#fef3c7";
    return "#ffedd5";
  };

  return `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <title>Feedback for ${escapeHtml(userName)}</title>
      <style>
        body {
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif;
          line-height: 1.6;
          color: #333;
          max-width: 800px;
          margin: 0 auto;
          padding: 40px 20px;
        }
        .header {
          text-align: center;
          margin-bottom: 40px;
          border-bottom: 3px solid #9333ea;
          padding-bottom: 20px;
        }
        h1 {
          font-size: 32px;
          color: #1f2937;
          margin-bottom: 10px;
        }
        .meta {
          color: #6b7280;
          font-size: 14px;
        }
        .score-summary {
          background: ${getScoreBgColor()};
          border: 2px solid ${getScoreColor()};
          border-radius: 12px;
          padding: 30px;
          margin-bottom: 40px;
          text-align: center;
          page-break-inside: avoid;
        }
        .score-number {
          font-size: 48px;
          font-weight: bold;
          color: ${getScoreColor()};
          margin-bottom: 8px;
        }
        .score-label {
          font-size: 12px;
          color: #6b7280;
          margin-bottom: 4px;
        }
        .participation-level {
          font-size: 18px;
          font-weight: 600;
          color: ${getScoreColor()};
          margin-bottom: 12px;
        }
        .score-scale {
          font-size: 11px;
          color: #6b7280;
          margin-top: 12px;
        }
        .feedback-item {
          margin-bottom: 40px;
          border-left: 4px solid #9333ea;
          padding-left: 24px;
          page-break-inside: avoid;
        }
        .feedback-title {
          font-size: 20px;
          font-weight: bold;
          color: #7c3aed;
          margin-bottom: 20px;
        }
        .section {
          margin-bottom: 20px;
        }
        .section-title {
          font-weight: 600;
          font-size: 14px;
          color: #4b5563;
          margin-bottom: 8px;
        }
        .section-content {
          color: #1f2937;
          line-height: 1.8;
        }
        .score-badge {
          display: inline-block;
          background: #f3e8ff;
          color: #7c3aed;
          padding: 8px 16px;
          border-radius: 6px;
          font-weight: 600;
          font-size: 14px;
        }
        .footer {
          margin-top: 60px;
          padding-top: 20px;
          border-top: 2px solid #e5e7eb;
          text-align: center;
          color: #6b7280;
          font-size: 12px;
        }
        @media print {
          body { padding: 20px; }
          .feedback-item { page-break-inside: avoid; }
          .score-summary { page-break-inside: avoid; }
        }
      </style>
    </head>
    <body>
      <div class="header">
        <h1>Feedback for ${escapeHtml(userName)}</h1>
        <p class="meta">Generated ${new Date().toLocaleDateString()} • From: ${escapeHtml(groupName)}</p>
      </div>
      
      <div class="score-summary">
        <div class="score-number">${averageScore}</div>
        <div class="score-label">Average Score</div>
        <div class="participation-level">${participationLevel.text}</div>
        <div class="score-scale">
          100-90: Great Participation • 89-80: Strong Participation • 79-70: Good Participation<br>
          69-60: Moderate Participation • Below 60: Developing Participation
        </div>
      </div>
      
      ${feedback
        .map(
          (item, idx) => `
        <div class="feedback-item">
          <div class="feedback-title">Response ${idx + 1}</div>
          
          <div class="section">
            <div class="section-title">What you did well:</div>
            <div class="section-content">${escapeHtml(item.strengths)}</div>
          </div>
          
          <div class="section">
            <div class="section-title">What you could improve:</div>
            <div class="section-content">${escapeHtml(item.improvements)}</div>
          </div>
          
          <div class="score-badge">Score: ${escapeHtml(item.score)} points</div>
        </div>
      `
        )
        .join("")}
      
      <div class="footer">
        <p>This feedback is anonymous. No names are attached to individual responses.</p>
        <p style="margin-top: 10px;">Generated by OffRecord</p>
      </div>
    </body>
    </html>
  `;
};

// ============================================================================
// INVITATION MODAL (VIEW INVITES)
// ============================================================================

const InvitationModal = ({ group, onClose }) => {
  const [loadingInvites, setLoadingInvites] = useState(true);
  const [invites, setInvites] = useState([]);

  useEffect(() => {
    let cancelled = false;

    const loadInvites = async () => {
      setLoadingInvites(true);
      try {
        const result = await listGroupInvitations({ groupId: group.id });
        if (!cancelled) setInvites(result);
      } finally {
        if (!cancelled) setLoadingInvites(false);
      }
    };

    void loadInvites();
    return () => {
      cancelled = true;
    };
  }, [group.id]);

  const invitesByEmail = new Map(
    invites.map((i) => [String(i.emailLower || "").toLowerCase(), i])
  );

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center p-4 z-50">
      <Card className="w-full max-w-2xl max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between mb-6">
          <h2 className="text-2xl font-bold text-white">Group Invitations</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-white text-2xl leading-none">
            ×
          </button>
        </div>

        <div className="space-y-4">
          <p className="text-gray-400 text-sm">
            Share these credentials with your group members so they can sign in and give feedback.
          </p>

          {loadingInvites ? (
            <div className="bg-gray-700 rounded-lg p-4">
              <p className="text-gray-300">Loading invitations…</p>
            </div>
          ) : (
            group.members.map((member, idx) => {
              const emailLower = String(member.emailLower || "").toLowerCase();
              const invite = invitesByEmail.get(emailLower);
              return (
                <div key={idx} className="bg-gray-700 rounded-lg p-4">
                  <div className="flex items-start justify-between mb-2">
                    <div className="flex-1">
                      <p className="text-white font-medium">{member.name}</p>
                      <p className="text-gray-400 text-sm">{emailLower}</p>
                    </div>
                  </div>
                  <div className="bg-gray-800 rounded px-3 py-2 mt-2">
                    <p className="text-purple-400 font-mono text-sm">
                      Password: {invite?.tempPassword || "—"}
                    </p>
                  </div>
                </div>
              );
            })
          )}
        </div>

        <div className="mt-6">
          <Button onClick={onClose} className="w-full">
            Close
          </Button>
        </div>
      </Card>
    </div>
  );
};

// ============================================================================
// SURVEY SCREEN
// ============================================================================

const SurveyScreen = ({ group, onComplete }) => {
  const { user } = useAuth();
  const [currentMemberIdx, setCurrentMemberIdx] = useState(0);
  const recipients = (group.members || []).filter(
    (m) => String(m.emailLower || "").toLowerCase() !== user.emailLower
  );
  const [responses, setResponses] = useState(() =>
    recipients.map((m) => ({
      recipientName: m.name,
      recipientEmailLower: String(m.emailLower || "").toLowerCase(),
      strengths: "",
      improvements: "",
      score: 0
    }))
  );
  const [showSuccess, setShowSuccess] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const totalPoints = recipients.length * 100;
  const allocatedPoints = responses.reduce((sum, r) => sum + r.score, 0);
  const remainingPoints = totalPoints - allocatedPoints;

  if (recipients.length === 0) {
    return (
      <div className="fixed inset-0 bg-gray-900 z-50 overflow-y-auto">
        <div className="max-w-2xl mx-auto px-4 py-8">
          <div className="flex items-center justify-between mb-8">
            <button onClick={onComplete} className="flex items-center gap-2 text-gray-400 hover:text-white transition">
              <ArrowLeft className="w-5 h-5" />
              <span>Back</span>
            </button>
          </div>
          <Card className="text-center">
            <h2 className="text-2xl font-bold text-white mb-2">No one else to review</h2>
            <p className="text-gray-400 mb-6">This group only has you as a member.</p>
            <Button
              onClick={async () => {
                setSubmitting(true);
                try {
                  await submitGroupResponse({
                    groupId: group.id,
                    respondentUid: user.uid,
                    respondentEmailLower: user.emailLower,
                    feedbackItems: []
                  });
                  setShowSuccess(true);
                  setTimeout(() => onComplete(), 800);
                } catch (err) {
                  alert(err?.message || "Failed to submit");
                } finally {
                  setSubmitting(false);
                }
              }}
              disabled={submitting}
              className="w-full"
            >
              {submitting ? "Submitting..." : "Mark Complete"}
            </Button>
          </Card>
        </div>
      </div>
    );
  }

  const currentMember = recipients[currentMemberIdx];
  const currentResponse = responses[currentMemberIdx];

  const updateResponse = (field, value) => {
    const updated = [...responses];
    updated[currentMemberIdx] = { ...updated[currentMemberIdx], [field]: value };
    setResponses(updated);
  };

  const canProceed = () => {
    return currentResponse.strengths.trim() && currentResponse.improvements.trim() && currentResponse.score > 0;
  };

  const handleNext = () => {
    if (currentMemberIdx < recipients.length - 1) {
      setCurrentMemberIdx(currentMemberIdx + 1);
    }
  };

  const handleBack = () => {
    if (currentMemberIdx > 0) {
      setCurrentMemberIdx(currentMemberIdx - 1);
    }
  };

  const handleSubmit = async () => {
    if (!user.emailLower) {
      alert("Missing your email. Please sign in again using your invite code.");
      return;
    }
    if (remainingPoints !== 0) {
      alert(`You must allocate exactly ${totalPoints} points. You have ${remainingPoints} points remaining.`);
      return;
    }

    setSubmitting(true);
    try {
      await submitGroupResponse({
        groupId: group.id,
        respondentUid: user.uid,
        respondentEmailLower: user.emailLower,
        feedbackItems: responses
      });

      const groupResponses = await listGroupResponses({ groupId: group.id });
      const respondents = new Set((groupResponses || []).map((r) => r.respondentUid).filter(Boolean));
      const totalParticipants = (group.members || []).length;
      const allComplete = totalParticipants > 0 && respondents.size === totalParticipants;

      setShowSuccess(true);

      setTimeout(() => {
        if (allComplete) {
          alert("🎉 All feedback collected! Everyone can now download their feedback PDFs from the dashboard.");
        }
        onComplete();
      }, 2000);
    } catch (err) {
      alert(err?.message || "Failed to submit feedback");
    } finally {
      setSubmitting(false);
    }
  };

  if (showSuccess) {
    return (
      <div className="fixed inset-0 bg-gray-900 flex items-center justify-center z-50">
        <Card className="max-w-md text-center">
          <div className="w-20 h-20 bg-green-500 rounded-full flex items-center justify-center mx-auto mb-6">
            <CheckCircle className="w-12 h-12 text-white" />
          </div>
          <h2 className="text-2xl font-bold text-white mb-2">Feedback Submitted</h2>
          <p className="text-gray-400">
            Your thoughtful responses have been recorded. You'll receive your feedback once everyone completes the survey.
          </p>
        </Card>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 bg-gray-900 z-50 overflow-y-auto">
      <div className="max-w-2xl mx-auto px-4 py-8">
        <div className="flex items-center justify-between mb-8">
          <button onClick={onComplete} className="flex items-center gap-2 text-gray-400 hover:text-white transition">
            <ArrowLeft className="w-5 h-5" />
            <span>Back</span>
          </button>
          <div className="text-gray-400 text-sm">
            {currentMemberIdx + 1} / {recipients.length}
          </div>
        </div>

        <div className="mb-8">
          <div className="flex gap-2">
            {recipients.map((_, idx) => (
              <div
                key={idx}
                className={`h-1 flex-1 rounded-full transition-all ${idx <= currentMemberIdx ? "bg-purple-600" : "bg-gray-700"}`}
              />
            ))}
          </div>
        </div>

        <Card>
          <div className="mb-6">
            <h2 className="text-2xl font-bold text-white mb-2">Feedback for {currentMember.name}</h2>
            <p className="text-gray-400">Be honest, specific, and constructive</p>
          </div>

          <div className="space-y-6">
            <Textarea
              label={`What did ${currentMember.name} do well?`}
              placeholder="Be specific about strengths and positive contributions..."
              value={currentResponse.strengths}
              onChange={(e) => updateResponse("strengths", e.target.value)}
            />

            <Textarea
              label={`What could ${currentMember.name} improve?`}
              placeholder="Provide constructive feedback for growth..."
              value={currentResponse.improvements}
              onChange={(e) => updateResponse("improvements", e.target.value)}
            />

            <div>
              <label className="block text-sm font-medium text-gray-300 mb-2">Score for {currentMember.name}</label>
              <input
                type="number"
                min="0"
                max={totalPoints}
                className="w-full px-4 py-3 bg-gray-700 border border-gray-600 rounded-lg text-white text-2xl font-bold focus:ring-2 focus:ring-purple-500 focus:border-transparent"
                value={currentResponse.score || ""}
                onChange={(e) => updateResponse("score", parseInt(e.target.value, 10) || 0)}
              />
            </div>

            <div
              className={`p-4 rounded-lg border-2 ${
                remainingPoints === 0
                  ? "bg-green-900/20 border-green-500"
                  : remainingPoints < 0
                    ? "bg-red-900/20 border-red-500"
                    : "bg-gray-700 border-gray-600"
              }`}
            >
              <div className="flex items-center justify-between">
                <span className="text-sm text-gray-300">Points remaining:</span>
                <span
                  className={`text-2xl font-bold ${
                    remainingPoints === 0 ? "text-green-400" : remainingPoints < 0 ? "text-red-400" : "text-white"
                  }`}
                >
                  {remainingPoints} / {totalPoints}
                </span>
              </div>
            </div>
          </div>

          <div className="flex gap-3 mt-8">
            {currentMemberIdx > 0 && (
              <Button variant="secondary" onClick={handleBack}>
                <ArrowLeft className="w-5 h-5" />
                Back
              </Button>
            )}

            {currentMemberIdx < recipients.length - 1 ? (
              <Button onClick={handleNext} disabled={!canProceed()} className="flex-1">
                Continue
              </Button>
            ) : (
              <Button
                onClick={handleSubmit}
                disabled={submitting || !canProceed() || remainingPoints !== 0}
                className="flex-1"
              >
                <Send className="w-5 h-5" />
                {submitting ? "Submitting..." : "Submit Feedback"}
              </Button>
            )}
          </div>
        </Card>
      </div>
    </div>
  );
};

// ============================================================================
// MAIN APP
// ============================================================================

const App = () => {
  return (
    <AuthProvider>
      <AppContent />
    </AuthProvider>
  );
};

const AppContent = () => {
  const { user, loading } = useAuth();

  if (supabaseInitError) {
    return (
      <div className="min-h-screen bg-gray-900 flex items-center justify-center p-4">
        <Card className="w-full max-w-xl">
          <h1 className="text-2xl font-bold text-white mb-2">Supabase not configured</h1>
          <p className="text-gray-300 mb-4">
            This deployment is missing required Supabase environment variables, so the app can’t start.
          </p>
          <div className="bg-gray-900/40 border border-gray-700 rounded-lg p-4 text-sm text-gray-200">
            <div className="font-mono">{supabaseInitError.message}</div>
          </div>
          <p className="text-gray-400 text-sm mt-4">
            Netlify → Site settings → Environment variables → add `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`,
            then redeploy.
          </p>
        </Card>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-900 flex items-center justify-center">
        <div className="text-white">Loading...</div>
      </div>
    );
  }

  return user ? <Dashboard /> : <AuthScreen />;
};

export default App;
