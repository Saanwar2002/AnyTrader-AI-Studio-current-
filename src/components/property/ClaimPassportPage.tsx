import React from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../AuthProvider";
import { ClaimPropertyPassportModal } from "./ClaimPropertyPassportModal";

export default function ClaimPassportPage() {
  const navigate = useNavigate();
  const { user } = useAuth();

  return (
    <div className="min-h-screen bg-slate-100">
      <ClaimPropertyPassportModal
        onClose={() => navigate(user ? "/portfolio" : "/")}
        onSuccess={() => navigate("/portfolio")}
      />
    </div>
  );
}
