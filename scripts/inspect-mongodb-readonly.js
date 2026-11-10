// Read-only Atlas inventory. This script deliberately uses the native MongoDB
// driver and only invokes connectionStatus, listCollections, and countDocuments.
// It never prints the URI, credentials, or document contents.
const path = require("node:path");
const dotenv = require("dotenv");
const { MongoClient } = require("mongodb");

dotenv.config({ path: path.resolve(__dirname, "..", ".env"), quiet: true });

function classifyError(error) {
    const nested = [...(error?.reason?.servers?.values?.() || [])].map((server) => server.error).filter(Boolean);
    const candidates = [error, error?.cause, ...nested, ...nested.map((item) => item.cause)].filter(Boolean);
    const messages = candidates.map((item) => item.message || "").join(" ").toLowerCase();
    const codes = candidates.map((item) => item.code).filter(Boolean);
    if (codes.includes(18) || /authentication failed|auth failed|authenticationfailure/.test(messages)) return "authentication_error";
    if (/ip access list|not on (the )?access list|not whitelisted|whitelist|ip address.*(allow|denied|not authorized|not allowed)/.test(messages)) return "atlas_ip_access_list_error";
    if (codes.some((code) => String(code).startsWith("ERR_TLS")) || /tls|ssl|certificate|handshake/.test(messages)) return "tls_error";
    if (codes.includes("ENOTFOUND") || codes.includes("EAI_AGAIN")) return "dns_error";
    if (codes.some((code) => ["ETIMEDOUT", "ECONNREFUSED", "ECONNRESET"].includes(code)) || error?.name === "MongoServerSelectionError") {
        return "network_or_ip_access_list_error";
    }
    return "other_connection_or_authorization_error";
}

function categoryFor(collectionName) {
    const name = collectionName.toLowerCase();
    if (/^(users?|accounts?)$/.test(name)) return "users";
    if (/^(groups?)$/.test(name)) return "groups";
    if (/^(conversations?|direct[_-]?messages?|dms?)$/.test(name)) return "conversations";
    if (/^(chats?|messages?)$/.test(name)) return "messages";
    return "other";
}

async function inspect() {
    const uri = process.env.DB_URL;
    if (!uri) {
        console.log(JSON.stringify({ status: "not_inspected", reason: "DB_URL is missing from .env" }));
        process.exitCode = 2;
        return;
    }

    let client;
    let connectionInfo = null;
    try {
        // Do not add Mongoose models here: model initialization can create indexes.
        client = new MongoClient(uri, { serverSelectionTimeoutMS: 10000, connectTimeoutMS: 7000 });
        connectionInfo = {
            scheme: uri.slice(0, uri.indexOf("://")),
            hostnames: client.options.hosts.map((host) => host.host),
            database: client.options.dbName || "(URI default database)",
            tls: client.options.tls ?? null,
            retryWrites: client.options.retryWrites ?? null,
            credentialsConfigured: Boolean(client.options.credentials?.username),
        };
        await client.connect();

        const database = client.db();
        let authenticated = false;
        let authenticationProbe = "connectionStatus";
        try {
            const status = await database.command({ connectionStatus: 1, showPrivileges: false });
            authenticated = Array.isArray(status.authInfo?.authenticatedUsers)
                && status.authInfo.authenticatedUsers.length > 0;
        } catch (error) {
            // A successful protected collection read below still verifies the
            // configured Atlas credentials without exposing the authenticated ID.
            authenticationProbe = "read-access-fallback";
            if (error.code === 18) throw error;
        }

        const collectionInfos = await database.listCollections({}, { nameOnly: true }).toArray();
        const collections = [];
        for (const { name } of collectionInfos) {
            const documentCount = await database.collection(name).countDocuments({});
            collections.push({ name, documentCount, category: categoryFor(name) });
        }

        const groupsCollection = collections.find((collection) => collection.category === "groups");
        let personalConversationCount = null;
        if (groupsCollection) {
            personalConversationCount = await database.collection(groupsCollection.name).countDocuments({ isPersonal: true });
        }

        const summary = { users: 0, groups: 0, conversations: 0, messages: 0 };
        for (const collection of collections) {
            if (Object.hasOwn(summary, collection.category)) summary[collection.category] += collection.documentCount;
        }
        if (personalConversationCount !== null) {
            summary.groups -= personalConversationCount;
            summary.conversations += personalConversationCount;
        }

        const recognizedDataCount = summary.users + summary.groups + summary.conversations + summary.messages;
        const totalDocumentCount = collections.reduce((total, collection) => total + collection.documentCount, 0);
        if (!authenticated && client.options.credentials?.username) {
            authenticated = true; // Atlas requires auth; successful collection reads prove credentials were accepted.
            authenticationProbe += "+successful-read";
        }
        console.log(JSON.stringify({
            status: "inspected",
            authentication: authenticated ? "succeeded" : "not confirmed",
            authenticationProbe,
            database: database.databaseName,
            connectionSettings: connectionInfo,
            collections,
            categoryDocumentCounts: summary,
            personalConversationsInGroups: personalConversationCount,
            totalDocumentCount,
            appearsToContainApplicationData: recognizedDataCount > 0,
            anyDocumentsFound: totalDocumentCount > 0,
            operations: ["connectionStatus", "listCollections", "countDocuments"],
            documentContentsRead: false,
            writesAttempted: false,
        }, null, 2));
    } catch (error) {
        const classification = classifyError(error);
        const nestedCodes = [...(error.reason?.servers?.values?.() || [])]
            .map((server) => server.error?.code || server.error?.cause?.code)
            .filter(Boolean);
        console.log(JSON.stringify({
            status: "connection_failed",
            authentication: classification === "authentication_error" ? "failed" : "not_confirmed",
            errorCategory: classification,
            errorCode: error.code || error.cause?.code || [...new Set(nestedCodes)].join(",") || null,
            connectionSettings: connectionInfo,
            uriAndCredentialsPrinted: false,
            documentContentsRead: false,
            writesAttempted: false,
            note: classification === "network_or_ip_access_list_error"
                ? "A server-selection timeout alone cannot distinguish network blocking from an Atlas IP access-list rejection."
                : undefined,
        }, null, 2));
        process.exitCode = 1;
    } finally {
        if (client) await client.close().catch(() => {});
    }
}

if (require.main === module) {
    inspect().catch(() => {
        // Keep unexpected errors sanitized as well.
        console.log(JSON.stringify({ status: "inspection_failed", errorCategory: "unexpected_error", uriAndCredentialsPrinted: false }));
        process.exitCode = 1;
    });
}

module.exports = { classifyError, categoryFor, inspect };
