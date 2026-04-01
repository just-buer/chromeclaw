window.__ulcopilot = { tools: {} };
window.__ulcopilot.registerTool = (name, cfg) => {
  window.__ulcopilot.tools[name] = cfg;
};

window.__ulcopilot.registerTool('fill_form', {
  description: '填充表单字段',
  params: [{ name: 'formData', type: 'object', description: '键值对' }],
  handler: async (args) => {
    const nativeSetter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype, 'value'
    )?.set;
    for (const [sel, val] of Object.entries(args.formData)) {
      const el = document.querySelector(sel);
      if (!el) continue;
      nativeSetter?.call(el, val);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }
    return { success: true };
  }
});

window.__ulcopilot.registerTool('fill_form', {
  description: '填充表单',
  requiresApproval: false,  // 声明不需要审批
  params: [...],
  handler: async (args) => { ... }
});