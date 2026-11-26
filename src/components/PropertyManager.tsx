import React, { useState, useEffect } from "react";
import { useAuth } from "./AuthProvider";
import { db, handleFirestoreError, OperationType, collection, query, where, onSnapshot, doc, updateDoc } from "@/src/firebase";
import { Plus, Building2, Wrench, Home, Briefcase, MapPin, Search, Edit, Trash2, Clock, Camera, ArrowLeft, CheckCircle2, Store, FileText, Share2 } from "lucide-react";
import { Link, useNavigate } from "react-router-dom";
import { cn } from "@/src/lib/utils";
import { motion, AnimatePresence } from "motion/react";
import { PropertyPassportModal } from "./PropertyPassportModal";
import { lookupPostcode } from "@/src/services/postcodeService";
import { toast } from "sonner";
import { createPropertyViaCommand, deletePropertyViaCommand, syncPublicPropertyPassport } from "../services/propertyCommandService";
import { compressPropertyImageFile } from "../utils/propertyPhotoUtils";

export function PropertyManager() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [properties, setProperties] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [isAdding, setIsAdding] = useState(false);
  const [step, setStep] = useState(1);
  const [showAllProperties, setShowAllProperties] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [editingPropertyId, setEditingPropertyId] = useState<string | null>(null);
  const [selectedPassportProperty, setSelectedPassportProperty] = useState<any>(null);
  
  // Form state
  const [propertyName, setPropertyName] = useState("");
  const [addressLine1, setAddressLine1] = useState("");
  const [postcode, setPostcode] = useState("");
  const [city, setCity] = useState("");
  const [propertyType, setPropertyType] = useState("residential");
  const [totalAreaSqFt, setTotalAreaSqFt] = useState("");
  const [unitCount, setUnitCount] = useState("");
  const [photos, setPhotos] = useState<string[]>([]);
  const [savingProperty, setSavingProperty] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [locatingAddress, setLocatingAddress] = useState(false);

  useEffect(() => {
    if (!user) return;
    
    const q = query(collection(db, "properties"), where("ownerId", "==", user.uid));
    const unsubscribe = onSnapshot(q, (snapshot) => {
      const p = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
      setProperties(p);
      setLoading(false);
    }, (error) => {
      console.error(error);
      handleFirestoreError(error, OperationType.LIST, "properties");
      setLoading(false);
    });
    
    return unsubscribe;
  }, [user]);

  const handleAddProperty = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user) return;

    let finalPostcode = postcode.trim().toUpperCase();
    let finalCity = city.trim();

    if (!finalPostcode) {
      toast.error("Please enter a valid UK postcode so local trade services can be routed to your property.");
      return;
    }

    if (finalPostcode && !finalCity) {
      try {
        const lookup = await lookupPostcode(finalPostcode);
        if (lookup) {
          finalPostcode = lookup.postcode;
          finalCity = lookup.city;
        }
      } catch (err) {
        console.warn("Postcode lookup failed:", err);
      }
    }

    const parsedArea = totalAreaSqFt.trim() ? Number(totalAreaSqFt) : undefined;
    const parsedUnits = unitCount.trim() ? Number(unitCount) : undefined;
    if (parsedArea !== undefined && (!Number.isFinite(parsedArea) || parsedArea <= 0)) {
      toast.error("Total area must be a positive number.");
      return;
    }
    if (parsedUnits !== undefined && (!Number.isInteger(parsedUnits) || parsedUnits <= 0)) {
      toast.error("Number of units must be a positive whole number.");
      return;
    }

    setSavingProperty(true);
    try {
      if (editingPropertyId) {
        const existingProp = properties.find((p) => p.id === editingPropertyId);
        await updateDoc(doc(db, "properties", editingPropertyId), {
          name: propertyName,
          "address.line1": addressLine1,
          "address.postcode": finalPostcode,
          "address.city": finalCity,
          postcode: finalPostcode,
          city: finalCity,
          propertyType: propertyType,
          totalAreaSqFt: parsedArea ?? null,
          unitCount: parsedUnits ?? null,
          photos,
          updatedAt: new Date().toISOString()
        });
        if (existingProp?.isPublicPassport === true && existingProp?.publicConsent === true) {
          syncPublicPropertyPassport(user, editingPropertyId).catch((err) =>
            console.warn("Non-fatal public passport sync after edit:", err)
          );
        }
        toast.success("Property updated successfully.");
      } else {
        await createPropertyViaCommand(user, {
          name: propertyName,
          address: { line1: addressLine1, city: finalCity, postcode: finalPostcode, country: "UK" },
          postcode: finalPostcode,
          city: finalCity,
          propertyType,
          ...(parsedArea !== undefined ? { totalAreaSqFt: parsedArea } : {}),
          ...(parsedUnits !== undefined ? { unitCount: parsedUnits } : {}),
          ...(photos.length > 0 ? { photos } : {})
        });
        toast.success("Property added to your portfolio.");
      }
      setIsAdding(false);
      setEditingPropertyId(null);
      setStep(1);
      setPropertyName("");
      setAddressLine1("");
      setPostcode("");
      setCity("");
      setPropertyType("residential");
      setTotalAreaSqFt("");
      setUnitCount("");
      setPhotos([]);
    } catch (error) {
      handleFirestoreError(error, editingPropertyId ? OperationType.UPDATE : OperationType.CREATE, "properties");
    } finally {
      setSavingProperty(false);
    }
  };

  const handlePhotoFilesChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    if (files.length === 0) return;
    const remainingSlots = Math.max(0, 8 - photos.length);
    if (remainingSlots === 0) {
      toast.error("Maximum of 8 property photos allowed.");
      e.target.value = "";
      return;
    }
    for (const file of files.slice(0, remainingSlots)) {
      if (!file.type.startsWith("image/")) {
        toast.error(`${file.name} is not a supported image file.`);
        continue;
      }
      if (file.size > 5 * 1024 * 1024) {
        toast.error(`${file.name} exceeds the 5 MB upload limit.`);
        continue;
      }
      try {
        const compressed = await compressPropertyImageFile(file);
        setPhotos((prev) => (prev.length < 8 ? [...prev, compressed] : prev));
      } catch (err: any) {
        toast.error(err?.message || `Could not process ${file.name}.`);
      }
    }
    e.target.value = "";
  };

  const handleLocateAddress = async () => {
    const candidate =
      postcode.trim() ||
      (addressLine1.match(/\b([A-Z]{1,2}[0-9][A-Z0-9]?\s*[0-9][A-Z]{2})\b/i)?.[1] || "");
    if (!candidate) {
      toast.info("Enter a UK postcode (or include it in Full Address) to look up location details.");
      return;
    }
    setLocatingAddress(true);
    try {
      const lookup = await lookupPostcode(candidate);
      if (lookup) {
        setPostcode(lookup.postcode);
        if (lookup.city) setCity(lookup.city);
        toast.success(`Location verified: ${lookup.postcode}${lookup.city ? ` • ${lookup.city}` : ""}`);
      } else {
        toast.error("Could not verify that postcode. Please check and try again.");
      }
    } catch {
      toast.error("Postcode lookup is temporarily unavailable.");
    } finally {
      setLocatingAddress(false);
    }
  };

  const handleAddNewClick = () => {
    setEditingPropertyId(null);
    setPropertyName("");
    setAddressLine1("");
    setPostcode("");
    setCity("");
    setPropertyType("residential");
    setTotalAreaSqFt("");
    setUnitCount("");
    setPhotos([]);
    setStep(1);
    setIsAdding(true);
  };

  const handleEditClick = (property: any) => {
    setPropertyName(property.name || "");
    setAddressLine1(property.address?.line1 || "");
    setPostcode(property.postcode || property.address?.postcode || "");
    setCity(property.city || property.address?.city || "");
    setPropertyType(property.propertyType || "residential");
    setTotalAreaSqFt(property.totalAreaSqFt ? String(property.totalAreaSqFt) : "");
    setUnitCount(property.unitCount ? String(property.unitCount) : "");
    setPhotos(Array.isArray(property.photos) ? property.photos : []);
    setEditingPropertyId(property.id);
    setIsAdding(true);
    setStep(1);
  };

  const handleDeleteProperty = async (propertyId: string) => {
    try {
      if (!user) throw new Error("You must be signed in to delete a property.");
      await deletePropertyViaCommand(user, propertyId);
      setDeletingId(null);
    } catch (error) {
      handleFirestoreError(error, OperationType.DELETE, `properties/${propertyId}`);
    }
  };

  if (loading) return <div className="p-6 text-center text-slate-500">Loading properties...</div>;

  return (
    <div className="space-y-6">
      {!isAdding ? (
        <>
          <div className="flex items-center justify-between">
            <button
              onClick={() => navigate("/dashboard")}
              className="inline-flex items-center gap-2 px-3.5 py-2 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-900 font-extrabold text-xs border border-black shadow-sm transition"
            >
              <ArrowLeft className="w-4 h-4 text-blue-600" />
              Back to Dashboard
            </button>
          </div>

          <h2 className="text-3xl font-black text-slate-900 tracking-tight">
            Portfolio
          </h2>

          <div className="relative flex gap-3 items-center">
            <div className="relative flex-1">
              <Search className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-slate-400" />
              <input 
                type="text" 
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search by name, address or postcode" 
                className="w-full pl-12 pr-4 py-3.5 rounded-xl border border-black bg-white focus:outline-none focus:ring-2 focus:ring-blue-500 text-sm shadow-sm"
              />
            </div>
            <button 
              onClick={handleAddNewClick}
              className="w-12 h-12 shrink-0 bg-blue-600 text-white rounded-full flex items-center justify-center shadow-lg hover:bg-blue-700 active:scale-95 transition"
            >
              <Plus className="w-6 h-6 stroke-2" />
            </button>
          </div>

          <div className="pt-2 pb-6">
            <div className="space-y-3">
              {(() => {
                const q = searchQuery.trim().toLowerCase();
                const filtered = q
                  ? properties.filter((p) =>
                      [p.name, p.address?.line1, p.address?.postcode, p.postcode, p.city, p.propertyType]
                        .filter(Boolean)
                        .some((v) => String(v).toLowerCase().includes(q))
                    )
                  : properties;
                if (properties.length === 0) {
                  return (
                    <div className="text-center py-8 text-slate-500 text-sm bg-white rounded-3xl shadow-sm border border-black">
                      No properties added yet. Click + to add your first property.
                    </div>
                  );
                }
                if (filtered.length === 0) {
                  return (
                    <div className="text-center py-8 text-slate-500 text-sm bg-white rounded-3xl shadow-sm border border-black">
                      No properties match &ldquo;{searchQuery}&rdquo;.
                    </div>
                  );
                }
                return (q ? filtered : filtered.slice(0, 3)).map(property => (
                <div key={property.id} className="flex items-stretch justify-between py-2 px-3 rounded-xl border border-black hover:bg-slate-50 transition group shadow-sm bg-white min-h-[72px]">
                  <div className="flex items-center gap-3 flex-1 min-w-0">
                    <div className="text-blue-600/80 shrink-0">
                      {property.propertyType === "commercial" ? (
                        <Briefcase className="w-5 h-5" strokeWidth={1.5} />
                      ) : property.propertyType === "apartment" ? (
                        <Building2 className="w-5 h-5" strokeWidth={1.5} />
                      ) : property.propertyType === "retail" ? (
                        <Store className="w-5 h-5" strokeWidth={1.5} />
                      ) : (
                        <Home className="w-5 h-5" strokeWidth={1.5} />
                      )}
                    </div>
                    <div className="flex flex-col flex-1 min-w-0 justify-center py-1">
                      <div className="flex items-center justify-between gap-2 w-full mb-1">
                        <h3 className="font-semibold text-slate-900 text-[14px] leading-tight truncate">{property.name || "Unnamed Property"}</h3>
                        <div className="flex items-center gap-2 mt-1">
                        <button
                          onClick={() => setSelectedPassportProperty(property)}
                          className="px-2.5 py-1 bg-slate-900 text-white rounded-lg text-[11px] font-extrabold flex items-center gap-1 hover:bg-blue-600 transition shadow-sm"
                        >
                          <FileText className="w-3 h-3 text-blue-400" />
                          Property Passport
                        </button>
                        <Link 
                          to={`/my-jobs?propertyId=${property.id}`}
                          className="text-[11px] text-blue-600 font-bold hover:underline transition shrink-0"
                        >
                          History
                        </Link>
                      </div>
                    </div>
                    {property.address?.line1 && (
                      <div className="text-[11px] text-black font-bold w-full break-words whitespace-normal leading-snug pt-0.5">
                        {property.address.line1}
                      </div>
                    )}
                  </div>
                </div>
                <div className="flex flex-col items-center justify-start gap-1.5 ml-3 shrink-0 pt-0.5">
                  <div className="relative">
                    {deletingId === property.id && (
                      <div className="absolute top-full mt-2 right-0 w-32 bg-slate-900 text-white text-[12px] p-2 rounded-xl text-center shadow-lg border border-white/20 z-10">
                        <p className="mb-2">Delete property?</p>
                        <div className="flex gap-2">
                          <button 
                            onClick={() => setDeletingId(null)}
                            className="flex-1 py-1 bg-slate-700 hover:bg-slate-600 rounded-lg transition"
                          >
                            No
                          </button>
                          <button 
                            onClick={() => handleDeleteProperty(property.id)}
                            className="flex-1 py-1 bg-red-500 hover:bg-red-600 rounded-lg transition"
                          >
                            Yes
                          </button>
                        </div>
                        <div className="absolute -top-1 right-2 w-2 h-2 bg-slate-900 rotate-45 border-t border-l border-white/20"></div>
                      </div>
                    )}
                    <button 
                      onClick={() => setDeletingId(property.id)}
                      className="text-red-500 hover:text-red-700 transition p-1"
                    >
                      <Trash2 className="w-[15px] h-[15px]" strokeWidth={1.5} />
                    </button>
                  </div>
                  
                  <button 
                    onClick={() => handleEditClick(property)}
                    className="text-blue-600 hover:text-blue-800 transition p-1"
                  >
                    <Edit className="w-[15px] h-[15px]" strokeWidth={1.5} />
                  </button>
                </div>
              </div>
            ));
              })()}
            
            {properties.length > 3 && !searchQuery.trim() && (
              <Link
                to="/portfolio"
                className="block text-center w-full py-2.5 text-sm font-medium text-slate-600 bg-slate-100 hover:bg-slate-200 rounded-xl transition-colors mt-2"
              >
                Show More
              </Link>
            )}
          </div>
        </div>

        {selectedPassportProperty && (
          <PropertyPassportModal
            property={selectedPassportProperty}
            onClose={() => setSelectedPassportProperty(null)}
          />
        )}
      </>
      ) : (
        <div className="fixed inset-0 z-[120] bg-slate-50 flex flex-col sm:p-4">
          <div className="bg-white flex-1 sm:rounded-3xl sm:max-w-md sm:mx-auto w-full sm:shadow-xl flex flex-col h-full overflow-hidden relative">
            
            {/* Header */}
            <div className="px-4 py-4 flex items-center justify-between border-b border-black bg-white z-10 shrink-0">
              <button onClick={() => { setIsAdding(false); setEditingPropertyId(null); }} className="p-2 -ml-2 text-slate-900 hover:bg-slate-100 rounded-full transition">
                <ArrowLeft className="w-6 h-6" />
              </button>
              <h2 className="text-lg font-semibold text-slate-900">{editingPropertyId ? 'Edit Property' : 'Add New Property'}</h2>
              <div className="w-10" /> {/* Spacer for centering */}
            </div>

            <div className="flex-1 overflow-y-auto flex flex-col">
              {/* Form Content */}
              <form id="add-property-form" onSubmit={handleAddProperty} className="p-6 space-y-6 flex-1">
                
                <div className="space-y-1.5">
                  <label className="block text-[15px] font-medium text-slate-900">Property Name</label>
                  <input 
                    type="text" 
                    value={propertyName}
                    onChange={e => setPropertyName(e.target.value)}
                    required
                    placeholder="e.g., Sunrise Apartments"
                    className="w-full px-4 py-3 rounded-xl border border-black focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white shadow-sm placeholder:text-slate-400 text-[15px]"
                  />
                </div>
                
                <div className="space-y-1.5">
                  <div className="flex justify-between items-center">
                    <label className="block text-[15px] font-medium text-slate-900">Full Address</label>
                    <button
                      type="button"
                      onClick={handleLocateAddress}
                      disabled={locatingAddress}
                      className="text-[13px] font-medium text-blue-600 flex items-center gap-1 hover:text-blue-800 transition"
                    >
                      <MapPin className="w-3.5 h-3.5" /> {locatingAddress ? "Verifying..." : "Verify Postcode"}
                    </button>
                  </div>
                  <input 
                    type="text" 
                    value={addressLine1}
                    onChange={e => setAddressLine1(e.target.value)}
                    required
                    placeholder="Enter street address"
                    className="w-full px-4 py-3 rounded-xl border border-black focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white shadow-sm placeholder:text-slate-400 text-[15px]"
                  />
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div className="space-y-1.5">
                    <label className="block text-[15px] font-medium text-slate-900">
                      Postcode <span className="text-red-500">*</span>
                    </label>
                    <input 
                      type="text" 
                      value={postcode}
                      onChange={async (e) => {
                        const val = e.target.value.toUpperCase();
                        setPostcode(val);
                        if (val.length >= 3) {
                          const data = await lookupPostcode(val);
                          if (data && data.city) {
                            setCity(data.city);
                          }
                        }
                      }}
                      required
                      placeholder="e.g. M14 5TP"
                      className="w-full px-4 py-3 rounded-xl border border-black focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white shadow-sm placeholder:text-slate-400 text-[15px] uppercase font-bold"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <label className="block text-[15px] font-medium text-slate-900">City / Town</label>
                    <input 
                      type="text" 
                      value={city}
                      onChange={e => setCity(e.target.value)}
                      placeholder="e.g. Manchester"
                      className="w-full px-4 py-3 rounded-xl border border-black focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white shadow-sm placeholder:text-slate-400 text-[15px]"
                    />
                  </div>
                </div>

                <div className="space-y-1.5">
                  <label className="block text-[15px] font-medium text-slate-900">Property Type</label>
                  <div className="flex p-1 bg-white border border-black rounded-xl text-[14px]">
                    {["Commercial", "Residential", "Industrial", "Retail"].map(type => {
                      const value = type.toLowerCase();
                      const isActive = propertyType === value;
                      return (
                        <button
                          key={value}
                          type="button"
                          onClick={() => setPropertyType(value)}
                          className={cn(
                            "flex-1 py-1.5 px-2 rounded-lg font-medium transition duration-200",
                            isActive ? "bg-black text-white shadow-sm" : "text-slate-600 hover:bg-slate-50"
                          )}
                        >
                          {type}
                        </button>
                      );
                    })}
                  </div>
                </div>

                <div className="space-y-3 pt-2">
                   <h3 className="text-[16px] font-bold text-slate-900">Property Details (Optional)</h3>
                   <input 
                     type="number" 
                     min="1"
                     value={totalAreaSqFt}
                     onChange={(e) => setTotalAreaSqFt(e.target.value)}
                     placeholder="Total Area (sq ft)" 
                     className="w-full px-4 py-3 rounded-xl border border-black bg-white shadow-sm placeholder:text-slate-400 text-[15px]" 
                   />
                   <input 
                     type="number" 
                     min="1"
                     step="1"
                     value={unitCount}
                     onChange={(e) => setUnitCount(e.target.value)}
                     placeholder="Number of Units" 
                     className="w-full px-4 py-3 rounded-xl border border-black bg-white shadow-sm placeholder:text-slate-400 text-[15px]" 
                   />
                </div>
                
                <div className="space-y-3">
                  <label className="w-full mt-2 border border-black rounded-xl py-6 px-4 flex flex-col items-center justify-center text-slate-700 hover:bg-slate-50 transition bg-white shadow-sm cursor-pointer">
                    <input
                      type="file"
                      accept="image/*"
                      multiple
                      onChange={handlePhotoFilesChange}
                      className="sr-only"
                    />
                    <Camera className="w-8 h-8 text-slate-500 mb-2" strokeWidth={1.5} />
                    <span className="font-semibold text-black">Upload Property Photos</span>
                    <p className="text-xs text-slate-600 mt-0.5">Up to 8 photos (max 2 MB each)</p>
                  </label>

                  {photos.length > 0 && (
                    <div className="grid grid-cols-4 gap-2">
                      {photos.map((photoUrl, idx) => (
                        <div key={idx} className="relative rounded-xl overflow-hidden border border-black aspect-square bg-slate-100">
                          <img src={photoUrl} alt={`Property preview ${idx + 1}`} className="w-full h-full object-cover" />
                          <button
                            type="button"
                            onClick={() => setPhotos((prev) => prev.filter((_, i) => i !== idx))}
                            aria-label={`Remove photo ${idx + 1}`}
                            className="absolute top-1 right-1 bg-black/80 text-white text-[10px] font-bold px-1.5 py-0.5 rounded-md hover:bg-red-600"
                          >
                            ×
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </form>
            </div>

            {/* Static Footer */}
            <div className="p-4 bg-white border-t border-black flex gap-3 shrink-0 pb-[calc(1rem+env(safe-area-inset-bottom,0px))]">
              <button 
                type="button" 
                onClick={() => setIsAdding(false)} 
                className="flex-[0.4] py-3.5 font-semibold text-black hover:bg-slate-50 rounded-full transition"
              >
                Cancel
              </button>
              <button 
                type="submit" 
                form="add-property-form"
                disabled={savingProperty}
                className="flex-1 py-3.5 font-semibold text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-60 active:bg-blue-800 rounded-full shadow-sm transition flex items-center justify-center gap-2"
              >
                {savingProperty ? "Saving..." : (editingPropertyId ? "Update Property" : "Save Property")}
              </button>
            </div>

          </div>
        </div>
      )}
    </div>
  );
}
