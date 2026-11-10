const OBJECT_ID_PATTERN = /^[a-f\d]{24}$/i;

function normalizeObjectId(value) {
    const candidate = value && typeof value === "object" && "_id" in value ? value._id : value;
    const id = typeof candidate === "string"
        ? candidate
        : candidate && typeof candidate.toHexString === "function"
            ? candidate.toHexString()
            : "";
    return OBJECT_ID_PATTERN.test(id) ? id.toLowerCase() : null;
}

function hasExplicitClassification(group) {
    // Mongoose applies schema defaults to missing fields during hydration.
    // $isDefault distinguishes that synthetic false from a stored false.
    if (typeof group.$isDefault === "function") return !group.$isDefault("isPersonal");
    return Object.prototype.hasOwnProperty.call(group, "isPersonal");
}

function canAccessRoom(group, userId) {
    if (!group || !hasExplicitClassification(group)) return false;

    if (group.isPersonal === false) return true;
    if (group.isPersonal !== true || !Array.isArray(group.participants) || group.participants.length !== 2) return false;

    const participantIds = group.participants.map(normalizeObjectId);
    const callerId = normalizeObjectId(userId);
    if (!callerId || participantIds.some((id) => !id) || new Set(participantIds).size !== 2) return false;
    return participantIds.includes(callerId);
}

module.exports = { canAccessRoom };
