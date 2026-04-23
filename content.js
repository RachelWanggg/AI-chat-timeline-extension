// content.js
(async () => {
  console.log("[Timeline] bootstrap");
  

  try {
    const module = await import(
      chrome.runtime.getURL('content/index.js')
      
    );
    console.log("[Timeline] module loaded:", module);

    if (module.init) {
      module.init();
    } else {
      console.warn("[Timeline] init not found");
    }
  } catch (e) {
    console.error("[Timeline] failed to load module", e);
  }
})();
