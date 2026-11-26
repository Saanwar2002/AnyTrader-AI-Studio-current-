import React, { createContext, useContext, useState, useEffect } from "react";
import { useAuth } from "../components/AuthProvider";

type PortalType = "anytrader" | "anyroller";
type ActiveRoleType = "customer" | "trader" | "business" | "admin" | "driver" | "ecosystem_manager";
type ThemeType = "light" | "dark" | "anyroller";

interface PortalContextType {
  activePortal: PortalType;
  switchPortal: (portal: PortalType) => void;
  activeRole: ActiveRoleType;
  setActiveRole: (role: ActiveRoleType) => void;
  availableRoles: ActiveRoleType[];
  theme: ThemeType;
  setTheme: (theme: ThemeType) => void;
  preventPortalSwitch: boolean;
  setPreventPortalSwitch: (prevent: boolean) => void;
}

const PortalContext = createContext<PortalContextType | undefined>(undefined);

export function PortalProvider({ children }: { children: React.ReactNode }) {
  const { user, profile } = useAuth();
  const prevUidRef = React.useRef<string | null>(user?.uid ?? null);
  
  // Default to anyroller if fleet_driver, otherwise anytrader
  const defaultPortal = profile?.role === "fleet_driver" ? "anyroller" : "anytrader";
  
  const [activePortal, setActivePortal] = useState<PortalType>(() => {
    const saved = localStorage.getItem("anytrader_active_portal");
    if (saved === "anytrader" || saved === "anyroller") {
      return saved;
    }
    return defaultPortal;
  });

  const [theme, setThemeState] = useState<ThemeType>(() => {
    const saved = localStorage.getItem("anyroller_theme") as ThemeType;
    return saved || "light";
  });

  const [preventPortalSwitch, setPreventPortalSwitch] = useState<boolean>(false);

  const setTheme = (newTheme: ThemeType) => {
    setThemeState(newTheme);
    localStorage.setItem("anyroller_theme", newTheme);
  };

  useEffect(() => {
    // Apply theme to body
    document.body.classList.remove("theme-dark", "theme-anyroller");
    if (theme === "dark") document.body.classList.add("theme-dark");
    if (theme === "anyroller") document.body.classList.add("theme-anyroller");
  }, [theme]);

  // Calculate user's available roles based on profile
  const availableRoles: ActiveRoleType[] = [];
  if (profile) {
    if (profile.role === "admin") availableRoles.push("admin");
    else if (profile.role === "ecosystem_manager") availableRoles.push("ecosystem_manager");
    else {
      availableRoles.push("customer"); // Everyone can be a customer / rider
      if (profile.role === "fleet_driver" || profile.role === "driver") availableRoles.push("driver");
      if (profile.role === "tradesperson") {
        availableRoles.push("trader");
      } else if (profile.role === "business" || profile.subscriptionType === "business") {
        availableRoles.push("business");
      }
    }
  }

  const getPrimaryAnyTraderRole = (): ActiveRoleType => {
    if (profile?.role === "admin") return "admin";
    if (profile?.role === "ecosystem_manager") return "ecosystem_manager";
    if (profile?.role === "tradesperson") return "trader";
    if (profile?.role === "business" || profile?.subscriptionType === "business") return "business";
    return "customer";
  };

  // Determine initial role
  const determineInitialRole = (): ActiveRoleType => {
    const saved = localStorage.getItem("anytrader_active_role") as ActiveRoleType;
    if (saved && availableRoles.includes(saved)) return saved;

    if (profile?.role === "admin") return "admin";
    if (profile?.role === "ecosystem_manager") return "ecosystem_manager";
    if ((profile?.role === "fleet_driver" || profile?.role === "driver") && activePortal === "anyroller") return "driver";
    return getPrimaryAnyTraderRole();
  };

  const [activeRole, setActiveRoleState] = useState<ActiveRoleType>(determineInitialRole());

  useEffect(() => {
    localStorage.setItem("anytrader_active_portal", activePortal);
  }, [activePortal]);

  useEffect(() => {
    localStorage.setItem("anytrader_active_role", activeRole);
  }, [activeRole]);

  useEffect(() => {
    const nextUid = user?.uid ?? null;
    if (nextUid !== prevUidRef.current) {
      prevUidRef.current = nextUid;
      setPreventPortalSwitch(false);
      if (!nextUid) {
        setActivePortal("anytrader");
        setActiveRoleState("customer");
        return;
      }
      setActivePortal(profile?.role === "fleet_driver" ? "anyroller" : "anytrader");
      setActiveRoleState(determineInitialRole());
    }
  }, [user?.uid]);

  // Sync role when profile loads/changes or portal switches (prevents stale role leaks across accounts)
  useEffect(() => {
    if (!profile) return;

    if (profile.role === "admin") {
      if (activeRole !== "admin") setActiveRoleState("admin");
      return;
    }
    if (profile.role === "ecosystem_manager") {
      if (activeRole !== "ecosystem_manager") setActiveRoleState("ecosystem_manager");
      return;
    }

    const isDriverProfile = profile.role === "fleet_driver" || profile.role === "driver";
    const primaryAnyTraderRole = getPrimaryAnyTraderRole();

    if (activePortal === "anyroller") {
      const targetRole: ActiveRoleType = isDriverProfile ? "driver" : "customer";
      if (activeRole !== targetRole) setActiveRoleState(targetRole);
      return;
    }

    // AnyTrader portal: never retain an unauthorized or stale role from a prior session
    if (!availableRoles.includes(activeRole) || activeRole === "driver") {
      setActiveRoleState(primaryAnyTraderRole);
      return;
    }

    // If user landed with no saved role preference (or stale saved role from another portal),
    // or just upgraded / hydrated with a saved preference matching their newly unlocked primary role,
    // switch into their primary role automatically.
    const saved = localStorage.getItem("anytrader_active_role") as ActiveRoleType | null;
    if (
      primaryAnyTraderRole !== "customer" &&
      activeRole === "customer" &&
      (!saved || !availableRoles.includes(saved) || saved === primaryAnyTraderRole)
    ) {
      setActiveRoleState(primaryAnyTraderRole);
    }
  }, [activePortal, profile, activeRole, availableRoles.join(",")]);

  const switchPortal = (portal: PortalType) => {
    setActivePortal(portal);
  };

  const setActiveRole = (role: ActiveRoleType) => {
    if (availableRoles.includes(role)) {
      setActiveRoleState(role);
    }
  };

  return (
    <PortalContext.Provider value={{ activePortal, switchPortal, activeRole, setActiveRole, availableRoles, theme, setTheme, preventPortalSwitch, setPreventPortalSwitch }}>
      {children}
    </PortalContext.Provider>
  );
}

export function usePortal() {
  const context = useContext(PortalContext);
  if (context === undefined) {
    throw new Error("usePortal must be used within a PortalProvider");
  }
  return context;
}
