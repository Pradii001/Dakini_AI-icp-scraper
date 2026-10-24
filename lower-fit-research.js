function createLowerFitResearchTargets(companies, requestedIds) {
  const requested = requestedIds ? new Set(requestedIds) : null;
  const domains = new Set();
  const targets = [];
  let skippedInvalidUrl = 0;
  let skippedDuplicateDomain = 0;

  for (const company of companies) {
    if (requested ? !requested.has(company.id) : company.score?.tier !== "Low fit") {
      continue;
    }

    let url;
    try {
      url = new URL(company.sourceUrl);
    } catch {
      skippedInvalidUrl += 1;
      continue;
    }
    if (!["http:", "https:"].includes(url.protocol)) {
      skippedInvalidUrl += 1;
      continue;
    }

    const domain = url.hostname.replace(/^www\./i, "").toLowerCase();
    if (domains.has(domain)) {
      skippedDuplicateDomain += 1;
      continue;
    }
    domains.add(domain);
    targets.push({
      id: company.id,
      companyName: company.companyName,
      sourceUrl: url.toString(),
      directoryUrl: company.directoryUrl || ""
    });
  }

  return { targets, skippedInvalidUrl, skippedDuplicateDomain };
}

module.exports = { createLowerFitResearchTargets };
