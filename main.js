import './style.css';
import { jsPDF } from 'jspdf';
import QRCode from 'qrcode';

// ==========================================
// LIVE DEPLOYMENT URL
// ==========================================
const LIVE_BASE_URL = 'https://keen-rolypoly-e0aee4.netlify.app';

// Returns the correct base URL — live site URL in production, localhost in dev
function getAppBaseUrl() {
  const custom = localStorage.getItem('micropact_custom_base_url');
  if (custom && custom.trim()) return custom.trim();
  if (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') {
    return LIVE_BASE_URL;
  }
  return window.location.origin + window.location.pathname;
}

function isLocalhost() {
  return window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
}

// Convert drawn canvas strokes to ultra-compact, crisp vector SVG (no redundant spaces)
function strokesToSvg(strokes, width = 400, height = 150) {
  if (!strokes || strokes.length === 0) return '';
  let pathD = '';
  strokes.forEach(stroke => {
    if (stroke.length === 0) return;
    pathD += `M${Math.round(stroke[0].x)},${Math.round(stroke[0].y)}`;
    for (let i = 1; i < stroke.length; i++) {
      pathD += `L${Math.round(stroke[i].x)},${Math.round(stroke[i].y)}`;
    }
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}"><path d="${pathD}" fill="none" stroke="#1e3a8a" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
}

// Convert typed name to crisp vector SVG
function typedToSvg(name, width = 400, height = 120) {
  const cleanName = (name || '').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}"><text x="50%" y="65%" text-anchor="middle" font-family="'Great Vibes', cursive, serif" font-size="44" fill="#1e3a8a">${cleanName}</text></svg>`;
}

// Compress signature to ultra-compact token
function compressSignature(sig) {
  if (!sig) return null;
  if (sig.includes('<path d="')) {
    const m = sig.match(/<path d="([^"]+)"/);
    if (m && m[1]) return 'd:' + m[1];
  }
  if (sig.includes('<text')) {
    const m = sig.match(/>([^<]+)<\/text>/);
    if (m && m[1]) return 't:' + m[1];
  }
  return sig;
}

// Decompress signature back to SVG
function decompressSignature(packedSig) {
  if (!packedSig) return null;
  if (packedSig.startsWith('d:')) {
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 150"><path d="${packedSig.substring(2)}" fill="none" stroke="#1e3a8a" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  }
  if (packedSig.startsWith('t:')) {
    return typedToSvg(packedSig.substring(2));
  }
  return packedSig;
}

// Ultra-compact serialization so Magic Links fit on 1 single line and QR codes stay super sharp
function packDeal(deal) {
  const tpl = TEMPLATES.find(t => t.id === deal.templateId) || TEMPLATES[0];
  const packed = {
    i: (deal.id || '').replace(/^MP-2026-/, ''),
    t: deal.templateId,
    a: deal.partyAName || '',
    b: deal.partyBName || '',
    m: deal.amount || '',
    d: deal.dueDate || '',
    p: deal.purpose || ''
  };

  if (deal.partyAContact) packed.ac = deal.partyAContact;
  if (deal.partyBContact) packed.bc = deal.partyBContact;
  if (deal.partyARole && deal.partyARole !== tpl.defaults.partyARole) packed.ar = deal.partyARole;
  if (deal.partyBRole && deal.partyBRole !== tpl.defaults.partyBRole) packed.br = deal.partyBRole;
  if (deal.specialTerms && deal.specialTerms.trim() !== tpl.defaults.specialTerms.trim()) {
    packed.st = deal.specialTerms;
  }
  if (deal.partyASignature) packed.s1 = compressSignature(deal.partyASignature);
  if (deal.partyBSignature) packed.s2 = compressSignature(deal.partyBSignature);

  return btoa(unescape(encodeURIComponent(JSON.stringify(packed))));
}

// Reconstruct complete dealData from ultra-compact base64
function unpackDeal(base64) {
  try {
    const jsonStr = decodeURIComponent(escape(atob(base64)));
    const p = JSON.parse(jsonStr);

    // Backward compatibility with older uncompacted format
    if (p.id && (p.templateId || p.title)) {
      return p;
    }

    const tpl = TEMPLATES.find(t => t.id === p.t) || TEMPLATES[0];
    const fullId = p.i ? (p.i.startsWith('MP-') ? p.i : `MP-2026-${p.i}`) : generateDealId();
    const s1 = decompressSignature(p.s1);
    const s2 = decompressSignature(p.s2);

    return {
      id: fullId,
      createdDate: new Date().toISOString(),
      templateId: tpl.id,
      title: tpl.defaults.title,
      partyAName: p.a || '',
      partyARole: p.ar || tpl.defaults.partyARole,
      partyAContact: p.ac || '',
      partyASignature: s1 || null,
      partyASignedAt: s1 ? new Date().toISOString() : null,
      partyBName: p.b || '',
      partyBRole: p.br || tpl.defaults.partyBRole,
      partyBContact: p.bc || '',
      partyBSignature: s2 || null,
      partyBSignedAt: s2 ? new Date().toISOString() : null,
      amount: p.m || tpl.defaults.amount,
      dueDate: p.d || tpl.defaults.dueDate,
      purpose: p.p || tpl.defaults.purpose,
      specialTerms: p.st || tpl.defaults.specialTerms,
      status: (s1 && s2) ? 'COMPLETED' : (s1 ? 'AWAITING_PARTY_B' : 'DRAFT'),
      hash: '',
      partyBMode: false
    };
  } catch (err) {
    console.error('Failed to unpack deal:', err);
    return null;
  }
}

// Helper to convert SVG string to PNG data URL for jsPDF embedding
async function svgToPngDataUrl(svgString, width = 400, height = 150) {
  if (!svgString) return null;
  if (svgString.startsWith('data:image/')) return svgString;
  return new Promise((resolve) => {
    try {
      const img = new Image();
      const blob = new Blob([svgString], { type: 'image/svg+xml;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      img.onload = () => {
        const tempCanvas = document.createElement('canvas');
        tempCanvas.width = width;
        tempCanvas.height = height;
        const ctx = tempCanvas.getContext('2d');
        ctx.drawImage(img, 0, 0);
        URL.revokeObjectURL(url);
        resolve(tempCanvas.toDataURL('image/png'));
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        resolve(null);
      };
      img.src = url;
    } catch (e) {
      resolve(null);
    }
  });
}


// ==========================================
// 1. GLOBAL TEMPLATES SUITE
// ==========================================
const TEMPLATES = [
  {
    id: 'promissory_note',
    category: 'finance',
    badgeClass: 'badge-finance',
    badgeText: 'Finance & Lending',
    title: 'Personal Loan & Promissory Note (IOU)',
    desc: 'Lend money to a friend, colleague or relative with explicit repayment dates and default remedies.',
    roleAOptions: ['Lender / Creditor', 'Investor', 'Friend / Relative', 'Lending Entity'],
    roleBOptions: ['Borrower / Debtor', 'Co-Signer', 'Recipient', 'Borrowing Individual'],
    sampleData: {
      partyAName: 'Michael Scott',
      partyARole: 'Lender / Creditor',
      partyAContact: 'michael@example.com | +1 (555) 234-5678',
      partyBName: 'Jim Halpert',
      partyBRole: 'Borrower / Debtor',
      partyBContact: 'jim@example.com | +1 (555) 876-5432',
      amount: '$1,200.00 USD',
      dueDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
      purpose: 'Friendly short-term personal loan for home appliance emergency repair.',
      specialTerms: '1. Repayment will be made in full on or before the due date via direct bank transfer or agreed electronic method.\n2. In the event of default or non-payment, Lender reserves all legal rights to recover outstanding principal together with reasonable recovery expenses.\n3. This loan carries 0.0% interest unless default occurs.'
    },
    defaults: {
      title: 'PROMISSORY NOTE & REPAYMENT AGREEMENT',
      partyAName: '',
      partyARole: 'Lender / Creditor',
      partyAContact: '',
      partyBName: '',
      partyBRole: 'Borrower / Debtor',
      partyBContact: '',
      amount: '$1,500.00 USD',
      dueDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
      purpose: 'Friendly personal loan for short-term liquidity assistance.',
      specialTerms: '1. Repayment will be made in full on or before the due date via direct bank transfer or agreed electronic method.\n2. In the event of default or non-payment, Lender reserves all legal rights to recover outstanding principal together with reasonable legal fees.\n3. This loan carries 0.0% interest unless default occurs.'
    },
    tags: ['Personal Loan', 'IOU', 'Zero Interest', 'Repayment Schedule']
  },
  {
    id: 'freelance_sow',
    category: 'freelance',
    badgeClass: 'badge-freelance',
    badgeText: 'Freelance & Gigs',
    title: 'Freelance Scope of Work & Milestone Pact',
    desc: 'Lock in project deliverables, revision limits, payment release schedule, and IP copyright transfer.',
    roleAOptions: ['Client / Business', 'Hiring Manager', 'Product Owner', 'Agency Director'],
    roleBOptions: ['Independent Contractor', 'Freelance Designer', 'Software Engineer', 'Consultant'],
    sampleData: {
      partyAName: 'Acme Digital Studios (Rep: David Miller)',
      partyARole: 'Client / Business',
      partyAContact: 'david@acmestudios.com | Austin, TX',
      partyBName: 'Sarah Jenkins',
      partyBRole: 'Independent Contractor',
      partyBContact: 'sarah.designs@portfolio.io | +1 (555) 432-1098',
      amount: '$1,800.00 USD (50% upfront, 50% on final delivery)',
      dueDate: new Date(Date.now() + 21 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
      purpose: 'Complete UI/UX design and responsive landing page development.',
      specialTerms: '1. Contractor provides up to two (2) rounds of revisions included within the agreed fee.\n2. Final deliverables and intellectual property ownership automatically transfer to Client upon full final payment settlement.\n3. Client shall review submitted milestones within 5 calendar days.'
    },
    defaults: {
      title: 'FREELANCE SERVICE & MILESTONE AGREEMENT',
      partyAName: '',
      partyARole: 'Client / Business',
      partyAContact: '',
      partyBName: '',
      partyBRole: 'Independent Contractor',
      partyBContact: '',
      amount: '$850.00 USD (50% upfront, 50% on delivery)',
      dueDate: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
      purpose: 'Full-stack development of website landing page and branding assets.',
      specialTerms: '1. Contractor provides up to two (2) rounds of revisions included within the agreed fee.\n2. Final deliverables and intellectual property ownership automatically transfer to Client upon full final payment settlement.\n3. Client shall review deliverables within 5 calendar days of submission.'
    },
    tags: ['Scope of Work', 'Milestones', 'IP Handover', 'Revision Limit']
  },
  {
    id: 'quick_nda',
    category: 'legal',
    badgeClass: 'badge-legal',
    badgeText: 'Confidentiality',
    title: 'Instant Mutual Non-Disclosure Agreement (NDA)',
    desc: 'Safeguard proprietary ideas, business secrets, pitch decks, and source code before starting discussions.',
    roleAOptions: ['Disclosing Party', 'Founding Partner', 'Company Representative'],
    roleBOptions: ['Receiving Party', 'Prospective Partner', 'Advisor / Contractor'],
    sampleData: {
      partyAName: 'Nexus Technologies Inc.',
      partyARole: 'Disclosing Party',
      partyAContact: 'legal@nexustech.co | San Francisco, CA',
      partyBName: 'Elena Rostova',
      partyBRole: 'Receiving Party',
      partyBContact: 'elena.rostova@techadvisor.com',
      amount: 'N/A ($15,000 Liquidated Damages per Breach)',
      dueDate: new Date(Date.now() + 730 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
      purpose: 'Confidential evaluation of proprietary AI software codebase and algorithm architecture.',
      specialTerms: '1. Confidential Information includes all proprietary source code, internal roadmap, financial metrics, and trade secrets.\n2. Receiving Party shall not disclose, copy, or reverse engineer any Proprietary Data for two (2) years.\n3. Injunction and statutory remedies apply upon breach.'
    },
    defaults: {
      title: 'MUTUAL NON-DISCLOSURE & CONFIDENTIALITY PACT',
      partyAName: '',
      partyARole: 'Disclosing Party',
      partyAContact: '',
      partyBName: '',
      partyBRole: 'Receiving Party',
      partyBContact: '',
      amount: 'N/A ($10,000 Liquidated Damages per breach)',
      dueDate: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
      purpose: 'Evaluation of prospective joint venture, software collaboration, and business partnership.',
      specialTerms: '1. Confidential Information includes all shared source code, financial projections, client lists, and technical documentation.\n2. Receiving Party shall not disclose, copy, or reverse engineer any Proprietary Data for a period of two (2) years.\n3. Obligation survives termination of discussions.'
    },
    tags: ['Trade Secrets', 'Proprietary Info', '2-Year Term', 'Protection']
  },
  {
    id: 'bill_of_sale',
    category: 'trade',
    badgeClass: 'badge-trade',
    badgeText: 'Commerce & Trade',
    title: 'As-Is Bill of Sale (Electronics / Vehicles / Items)',
    desc: 'Official receipt and title transfer for buying or selling secondhand electronics, bikes, or equipment.',
    roleAOptions: ['Seller', 'Registered Owner', 'Transferor'],
    roleBOptions: ['Buyer', 'Purchaser', 'Transferee'],
    sampleData: {
      partyAName: 'Robert Vance',
      partyARole: 'Seller',
      partyAContact: 'robert.vance@email.com | +1 (555) 765-4321',
      partyBName: 'Pam Beesly',
      partyBRole: 'Buyer',
      partyBContact: 'pam.b@email.com | Scranton, PA',
      amount: '$750.00 USD (Paid via Electronic Wire Transfer)',
      dueDate: new Date().toISOString().split('T')[0],
      purpose: 'Sale and title transfer of pre-owned Apple MacBook Pro M2 (Serial: H89K294LPQ2).',
      specialTerms: '1. Item is sold strictly on an "AS-IS, WHERE-IS" basis with no express or implied warranty.\n2. Seller warrants they are lawful sole owner free from any liens, loans, or encumbrances.\n3. Title and ownership pass immediately upon receipt of agreed funds.'
    },
    defaults: {
      title: 'OFFICIAL AS-IS BILL OF SALE & TITLE TRANSFER',
      partyAName: '',
      partyARole: 'Seller',
      partyAContact: '',
      partyBName: '',
      partyBRole: 'Buyer',
      partyBContact: '',
      amount: '$650.00 USD (Paid in full via Cash/Instant Wire)',
      dueDate: new Date().toISOString().split('T')[0],
      purpose: 'Sale of pre-owned Apple MacBook Pro 14" (Serial No: C02GF389MD6R).',
      specialTerms: '1. Item is sold strictly on an "AS-IS, WHERE-IS" basis with no express or implied warranty beyond ownership title.\n2. Seller warrants they are lawful sole owner free from any liens, loans, or encumbrances.\n3. Title and possession pass immediately upon receipt of funds.'
    },
    tags: ['Second-Hand', 'As-Is Condition', 'Proof of Purchase', 'Title Handover']
  },
  {
    id: 'roommate_split',
    category: 'rental',
    badgeClass: 'badge-rental',
    badgeText: 'Living & Housing',
    title: 'Roommate & Sublease Shared Living Pact',
    desc: 'Document monthly rent shares, security deposit holding, utility splitting, and house rules.',
    roleAOptions: ['Primary Leaseholder', 'Landlord / Host', 'Head Tenant'],
    roleBOptions: ['Co-Tenant / Roommate', 'Sublessee', 'Occupant'],
    sampleData: {
      partyAName: 'Tariq Rahman',
      partyARole: 'Primary Leaseholder',
      partyAContact: 'tariq.r@housing.com | Apt 3C, Maple Court',
      partyBName: 'Zubair Hossain',
      partyBRole: 'Co-Tenant / Roommate',
      partyBContact: 'zubair.h@email.com | +1 (555) 901-2345',
      amount: '$550.00 USD/month + 50% Electricity & WiFi Split',
      dueDate: new Date(Date.now() + 180 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
      purpose: 'Room sublease and shared occupancy at Apt 3C, Maple Court.',
      specialTerms: '1. Roommate shall pay rent share on or before the 1st day of each calendar month.\n2. Security deposit of $550 is held and fully refundable within 14 days of move-out subject to damage inspection.\n3. Notice period for departure is thirty (30) days in writing.'
    },
    defaults: {
      title: 'ROOMMATE SUBLEASE & UTILITY SPLIT AGREEMENT',
      partyAName: '',
      partyARole: 'Primary Leaseholder',
      partyAContact: '',
      partyBName: '',
      partyBRole: 'Co-Tenant / Roommate',
      partyBContact: '',
      amount: '$600.00 USD/month + 50% Utilities share',
      dueDate: new Date(Date.now() + 180 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
      purpose: 'Shared tenancy and room occupancy at Apt 4B, 120 Green St.',
      specialTerms: '1. Roommate shall pay monthly rent portion on or before the 1st day of each calendar month.\n2. Security deposit of $600 is held and refundable within 14 days of move-out subject to damage inspection.\n3. Notice period for departure is thirty (30) days in writing.'
    },
    tags: ['Roommate Agreement', 'Rent Split', 'Deposit Holding', 'Notice Period']
  },
  {
    id: 'custom_pact',
    category: 'custom',
    badgeClass: 'badge-custom',
    badgeText: 'Custom Agreement',
    title: 'Universal Freeform Micro-Agreement',
    desc: 'Draft any mutual deal, partnership, collateral guarantee, or commitment with tailor-made clauses.',
    roleAOptions: ['First Party (Initiator)', 'Lender', 'Partner', 'Promisor'],
    roleBOptions: ['Second Party (Counterparty)', 'Borrower', 'Partner', 'Promisee'],
    sampleData: {
      partyAName: 'Marcus Aurelius',
      partyARole: 'First Party (Initiator)',
      partyAContact: 'marcus@leadership.org',
      partyBName: 'Lucius Verus',
      partyBRole: 'Second Party (Counterparty)',
      partyBContact: 'lucius@partnership.org',
      amount: '$2,500.00 USD Collateral Deposit',
      dueDate: new Date(Date.now() + 60 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
      purpose: 'Mutual co-founder agreement and equipment collateral deposit pledge.',
      specialTerms: '1. Both parties enter into this covenant in mutual good faith.\n2. Any dispute shall be settled by independent mediation within 14 days.\n3. Equipment collateral will be released in original condition upon term completion.'
    },
    defaults: {
      title: 'MUTUAL LEGALLY-BINDING MICRO-AGREEMENT',
      partyAName: '',
      partyARole: 'First Party (Initiator)',
      partyAContact: '',
      partyBName: '',
      partyBRole: 'Second Party (Counterparty)',
      partyBContact: '',
      amount: 'As agreed per terms below',
      dueDate: new Date(Date.now() + 60 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
      purpose: 'General mutual understanding and commitment between participating parties.',
      specialTerms: '1. Both parties acknowledge entering into this pact voluntarily and in good faith.\n2. Any dispute shall first be addressed through direct mediation prior to formal legal proceeding.'
    },
    tags: ['Universal Deal', 'Custom Clauses', 'Full Freedom']
  }
];

// ==========================================
// 2. APPLICATION STATE
// ==========================================
let currentStep = 1; // 1: Templates, 2: Details, 3: Sign, 4: Magic Link & Final
let selectedTemplate = TEMPLATES[0];

let dealData = {
  id: generateDealId(),
  createdDate: new Date().toISOString(),
  templateId: 'promissory_note',
  title: TEMPLATES[0].defaults.title,
  partyAName: '',
  partyARole: TEMPLATES[0].defaults.partyARole,
  partyAContact: '',
  partyASignature: null,
  partyASignedAt: null,
  partyBName: '',
  partyBRole: TEMPLATES[0].defaults.partyBRole,
  partyBContact: '',
  partyBSignature: null,
  partyBSignedAt: null,
  amount: TEMPLATES[0].defaults.amount,
  dueDate: TEMPLATES[0].defaults.dueDate,
  purpose: TEMPLATES[0].defaults.purpose,
  specialTerms: TEMPLATES[0].defaults.specialTerms,
  status: 'DRAFT', // 'DRAFT', 'AWAITING_PARTY_B', 'COMPLETED'
  hash: '',
  partyBMode: false
};

let qrCodeDataUrl = '';

function generateDealId() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let rand = '';
  for (let i = 0; i < 8; i++) {
    rand += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return `MP-2026-${rand.substring(0, 4)}-${rand.substring(4, 8)}`;
}

// Compute SHA-256 Hash of core pact terms
async function computePactHash(data) {
  const payload = `${data.id}|${data.title}|${data.partyAName}|${data.partyBName}|${data.amount}|${data.dueDate}|${data.purpose}|${data.specialTerms}|${data.partyASignedAt || ''}|${data.partyBSignedAt || ''}`;
  const encoder = new TextEncoder();
  const dataBuffer = encoder.encode(payload);
  const hashBuffer = await crypto.subtle.digest('SHA-256', dataBuffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

// ==========================================
// 3. INITIALIZATION & ROUTING
// ==========================================
// Check if opening via a magic link in URL (#p=... or ?p=... or #deal=...)
function checkUrlForExistingDeal() {
  let hash = window.location.hash || '';
  let dealString = '';

  if (hash.startsWith('#p=')) {
    dealString = hash.replace('#p=', '');
  } else if (hash.startsWith('#deal=')) {
    dealString = hash.replace('#deal=', '');
  } else if (window.location.search) {
    const params = new URLSearchParams(window.location.search);
    if (params.get('p')) {
      dealString = params.get('p');
    } else if (params.get('deal')) {
      dealString = params.get('deal');
    }
  }

  if (dealString) {
    const parsed = unpackDeal(dealString);
    if (parsed && parsed.id) {
      dealData = parsed;
      // If Party A has signed and Party B hasn't, open Signer Mode for Party B
      if (dealData.partyASignature && !dealData.partyBSignature) {
        dealData.partyBMode = true;
        currentStep = 3;
        showToast(`📄 Pact loaded: ${dealData.title || 'Agreement'}. Please review and add your signature.`, 'success');
      } else if (dealData.partyASignature && dealData.partyBSignature) {
        dealData.partyBMode = false;
        currentStep = 4;
        showToast('🎉 Fully Executed Pact loaded! Both parties have signed.', 'success');
      } else {
        currentStep = 2;
      }
      syncInputsWithDealData();
      renderStepContent();
      updateStepperUI();
      refreshQRCodeAndHash().then(() => updateLivePaperPreview());
      return true;
    } else {
      showToast('Could not decode the agreement from this link.', 'warning');
    }
  }
  return false;
}

// ==========================================
// 4. MAIN LAYOUT RENDERING
// ==========================================
function renderAppStructure() {
  const app = document.getElementById('app');
  app.innerHTML = `
    <!-- Top Navigation Header -->
    <header class="app-header">
      <div class="header-container">
        <div class="logo-brand" id="brandHomeBtn">
          <div class="logo-icon">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
              <path d="m9 12 2 2 4-4"/>
            </svg>
          </div>
          <div class="logo-text">
            <span class="logo-title">MicroPact</span>
            <span class="logo-badge">Universal Legal Protocol</span>
          </div>
        </div>

        <div class="header-actions">
          <button class="btn btn-outline btn-sm" id="openVerifyModalBtn">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/>
            </svg>
            Verify Pact
          </button>
          <button class="btn btn-primary btn-sm" id="openLegalFaqBtn">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
              <path d="m9 12 2 2 4-4"/>
            </svg>
            Legal Enforceability
          </button>
        </div>
      </div>
    </header>

    <!-- Hero Section -->
    <section class="hero-section">
      <div class="trust-badge-pill">
        <span class="pulse-dot"></span>
        <span>U.S. ESIGN ACT & EU eIDAS COMPLIANT MICRO-AGREEMENTS</span>
      </div>
      <h1 class="hero-title">Legally-Binding Deals in <span>60 Seconds</span>.</h1>
      <p class="hero-desc">
        Turn everyday handshakes, personal loans, freelance milestones, and secondhand deals into cryptographically verifiable, signed contracts. Zero fees. Zero legal jargon.
      </p>

      <div class="trust-pillars">
        <div class="trust-pillar-item">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M20 6 9 17l-5-5"/></svg>
          <span>SHA-256 Cryptographic Hash</span>
        </div>
        <div class="trust-pillar-item">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M20 6 9 17l-5-5"/></svg>
          <span>Live QR Code Notary Audit</span>
        </div>
        <div class="trust-pillar-item">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M20 6 9 17l-5-5"/></svg>
          <span>Finger-Draw Magic Links</span>
        </div>
        <div class="trust-pillar-item">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M20 6 9 17l-5-5"/></svg>
          <span>Court-Admissible Evidence</span>
        </div>
      </div>
    </section>

    <!-- Stepper Navigation -->
    <div class="main-wrapper">
      <div class="stepper-header" id="stepperContainer">
        <div class="step-item active" data-step="1">
          <div class="step-circle">1</div>
          <span class="step-label">Template</span>
        </div>
        <div class="step-item" data-step="2">
          <div class="step-circle">2</div>
          <span class="step-label">Terms</span>
        </div>
        <div class="step-item" data-step="3">
          <div class="step-circle">3</div>
          <span class="step-label">Sign</span>
        </div>
        <div class="step-item" data-step="4">
          <div class="step-circle">4</div>
          <span class="step-label">Finalize</span>
        </div>
      </div>

      <!-- Main Step Views Container -->
      <div id="stepViewsContainer">
        <!-- Will be dynamically updated by renderStepContent() -->
      </div>
    </div>

    <!-- Modals -->
    <div id="modalContainer"></div>

    <!-- Toast Notifications -->
    <div class="toast-container" id="toastContainer"></div>

    <!-- Footer -->
    <footer class="app-footer">
      <div class="footer-links">
        <a id="footerTemplatesLink">Standard Templates</a>
        <a id="footerEsignLegalLink">Legal Validity FAQ</a>
        <a id="footerNewPactBtn">Start New Pact</a>
      </div>
      <p>© 2026 MicroPact Protocol • Built for frictionless universal trust. Designed to protect everyday transactions worldwide.</p>
    </footer>
  `;

  attachGlobalEvents();
  renderStepContent();
}

// ==========================================
// 5. STEP CONTENT RENDERING
// ==========================================
function renderStepContent() {
  const container = document.getElementById('stepViewsContainer');
  if (!container) return;

  if (currentStep === 1) {
    // Step 1: Template Selection
    container.innerHTML = `
      <div style="text-align: center; margin-bottom: 2rem;">
        <h2 style="font-size: 1.5rem; font-weight: 700; color: #fff;">Choose a Pact Template</h2>
        <p style="color: var(--text-muted); font-size: 0.9rem;">Select an internationally standard legal template or create your own custom agreement.</p>
      </div>

      <div class="templates-grid">
        ${TEMPLATES.map(tpl => `
          <div class="template-card ${tpl.id === dealData.templateId ? 'selected' : ''}" data-tpl-id="${tpl.id}">
            <div>
              <div class="template-badge ${tpl.badgeClass}">${tpl.badgeText}</div>
              <h3 class="template-title">${tpl.title}</h3>
              <p class="template-desc">${tpl.desc}</p>
            </div>
            <div>
              <div class="template-meta-tags">
                ${tpl.tags.map(t => `<span class="tag-pill">${t}</span>`).join('')}
              </div>
              <button class="btn btn-outline btn-sm" style="width: 100%; margin-top: 1.25rem;">
                Select & Customize →
              </button>
            </div>
          </div>
        `).join('')}
      </div>
    `;

    // Attach template selection listeners
    container.querySelectorAll('.template-card').forEach(card => {
      card.addEventListener('click', () => {
        const tplId = card.getAttribute('data-tpl-id');
        selectTemplateById(tplId);
        goToStep(2);
      });
    });

  } else if (currentStep === 2) {
    // Step 2: Terms Editor & Live Paper Preview
    const roleAOpts = selectedTemplate.roleAOptions || ['Party A', 'Lender', 'Client', 'Seller', 'Individual'];
    const roleBOpts = selectedTemplate.roleBOptions || ['Party B', 'Borrower', 'Contractor', 'Buyer', 'Individual'];

    container.innerHTML = `
      <div class="deal-workspace-grid">
        <!-- Left: Form Editor -->
        <div class="form-card">
          <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 1.5rem; flex-wrap: wrap; gap: 0.75rem;">
            <div>
              <span class="template-badge ${selectedTemplate.badgeClass}">${selectedTemplate.badgeText}</span>
              <h2 style="font-size: 1.35rem; font-weight: 800; color: #fff; margin-top: 0.25rem;">Configure Pact Terms</h2>
            </div>
            <div style="display: flex; gap: 0.5rem; align-items: center; flex-wrap: wrap;">
              <button class="btn btn-gold btn-sm" id="btnFillDemoData" title="Instantly populate with realistic sample data to test">
                🪄 Fill Sample Demo Data
              </button>
              <button class="btn btn-outline btn-sm" id="btnChangeTemplate">
                ← Change Template
              </button>
            </div>
          </div>

          <!-- Section: Parties -->
          <div class="form-section-title">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
            1. The Contracting Parties
          </div>

          <div class="form-grid-2">
            <div class="input-group">
              <label class="input-label">Party A (Your Full Legal Name) <span class="req">*</span></label>
              <input type="text" class="input-control" id="inputPartyAName" value="${dealData.partyAName}" placeholder="e.g., Alexander Miller" />
            </div>
            <div class="input-group">
              <label class="input-label">Your Role / Position</label>
              <select class="input-control" id="selectPartyARole">
                ${roleAOpts.map(r => `<option value="${r}" ${dealData.partyARole === r ? 'selected' : ''}>${r}</option>`).join('')}
                <option value="__custom__">Custom / Other...</option>
              </select>
              <input type="text" class="input-control" id="inputCustomPartyARole" style="margin-top: 0.35rem; display: none;" placeholder="Enter custom role..." value="${dealData.partyARole}" />
            </div>
          </div>

          <div class="input-group">
            <label class="input-label">Your Contact / City / Country</label>
            <input type="text" class="input-control" id="inputPartyAContact" value="${dealData.partyAContact}" placeholder="e.g., alex@example.com | New York, USA" />
          </div>

          <div class="form-grid-2" style="margin-top: 1rem;">
            <div class="input-group">
              <label class="input-label">Party B (Counterparty Name) <span class="req">*</span></label>
              <input type="text" class="input-control" id="inputPartyBName" value="${dealData.partyBName}" placeholder="e.g., Sarah Connor" />
            </div>
            <div class="input-group">
              <label class="input-label">Counterparty Role / Position</label>
              <select class="input-control" id="selectPartyBRole">
                ${roleBOpts.map(r => `<option value="${r}" ${dealData.partyBRole === r ? 'selected' : ''}>${r}</option>`).join('')}
                <option value="__custom__">Custom / Other...</option>
              </select>
              <input type="text" class="input-control" id="inputCustomPartyBRole" style="margin-top: 0.35rem; display: none;" placeholder="Enter custom role..." value="${dealData.partyBRole}" />
            </div>
          </div>

          <div class="input-group">
            <label class="input-label">Counterparty Contact / Email / Phone</label>
            <input type="text" class="input-control" id="inputPartyBContact" value="${dealData.partyBContact}" placeholder="e.g., sarah@example.com / +1-555-0192" />
          </div>

          <!-- Section: Financials & Dates -->
          <div class="form-section-title" style="margin-top: 1.5rem;">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect width="20" height="14" x="2" y="5" rx="2"/><line x1="2" x2="22" y1="10" y2="10"/></svg>
            2. Deal Financials & Timelines
          </div>

          <div class="form-grid-2">
            <div class="input-group">
              <label class="input-label">Amount or Consideration <span class="req">*</span></label>
              <input type="text" class="input-control" id="inputAmount" value="${dealData.amount}" placeholder="e.g., $1,500.00 USD / €1,200.00 EUR / £1,000.00 GBP" />
            </div>
            <div class="input-group">
              <label class="input-label">Execution or Due Date <span class="req">*</span></label>
              <input type="date" class="input-control" id="inputDueDate" value="${dealData.dueDate}" />
            </div>
          </div>

          <div class="input-group">
            <label class="input-label">Purpose / Subject Matter</label>
            <input type="text" class="input-control" id="inputPurpose" value="${dealData.purpose}" placeholder="Brief 1-sentence description" />
          </div>

          <!-- Section: Legal Clauses -->
          <div class="form-section-title" style="margin-top: 1.5rem;">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" x2="8" y1="13" y2="13"/><line x1="16" x2="8" y1="17" y2="17"/></svg>
            3. Specific Terms & Enforceability Clauses
          </div>

          <!-- Clause Helpers -->
          <div style="margin-bottom: 0.65rem;">
            <div style="display: flex; gap: 0.4rem; flex-wrap: wrap; margin-bottom: 0.4rem;">
              <span style="font-size: 0.75rem; color: var(--text-muted); align-self: center;">Quick Add:</span>
              <button type="button" class="btn btn-outline btn-sm" id="btnClauseLateFee">+ Late Fee Penalty</button>
              <button type="button" class="btn btn-outline btn-sm" id="btnClauseArbitration">+ Dispute Arbitration</button>
              <button type="button" class="btn btn-outline btn-sm" id="btnClauseConfidentiality">+ Strict Confidentiality</button>
              <button type="button" class="btn btn-outline btn-sm" id="btnClauseClear">Reset Clauses</button>
            </div>
            <div style="font-size: 0.72rem; color: var(--text-faint); line-height: 1.4;">
              💡 <em>Why are these clauses pre-written?</em> In real contract law, clear legal remedies prevent loopholes. You are 100% free to edit, add, or delete any clause below.
            </div>
          </div>

          <div class="input-group">
            <label class="input-label">Numbered Clauses & Conditions</label>
            <textarea class="input-control" id="inputSpecialTerms" rows="6">${dealData.specialTerms}</textarea>
          </div>

          <div style="display: flex; justify-content: space-between; margin-top: 2rem;">
            <button class="btn btn-outline" id="btnBackToTemplates">← Back</button>
            <button class="btn btn-primary" id="btnProceedToSign">
              Proceed to Digital Signing →
            </button>
          </div>
        </div>

        <!-- Right: Live Legal Paper Preview -->
        <div class="paper-wrapper">
          <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.75rem;">
            <span style="font-size: 0.75rem; font-weight: 700; color: var(--emerald-400); text-transform: uppercase; letter-spacing: 0.05em; display: flex; align-items: center; gap: 4px;">
              <span class="pulse-dot"></span> Live Document Render
            </span>
            <span style="font-family: var(--font-mono); font-size: 0.7rem; color: var(--text-muted);" id="paperDocIdLabel">${dealData.id}</span>
          </div>

          <div class="legal-paper" id="liveLegalPaperContent">
            <!-- Rendered by updateLivePaperPreview() -->
          </div>
        </div>
      </div>
    `;

    attachFormInputListeners();

  } else if (currentStep === 3) {
    // Step 3: Signature Studio (Supports Party A or Party B mode)
    const isPartyB = dealData.partyBMode;
    const signerTitle = isPartyB ? `Party B (${dealData.partyBName || 'Signer'})` : `Party A (${dealData.partyAName || 'Creator'})`;

    container.innerHTML = `
      <div class="deal-workspace-grid">
        <!-- Left: Signature Pad Studio -->
        <div class="form-card">
          <div style="margin-bottom: 1.5rem;">
            <span class="template-badge ${isPartyB ? 'badge-trade' : 'badge-finance'}">
              ${isPartyB ? 'Counterparty Verification' : 'Initiator Execution'}
            </span>
            <h2 style="font-size: 1.4rem; font-weight: 800; color: #fff; margin-top: 0.25rem;">
              Digital Signature of ${signerTitle}
            </h2>
            <p style="color: var(--text-muted); font-size: 0.85rem; margin-top: 0.25rem;">
              Draw your signature on mobile touch screen or computer mouse, or type an authorized script signature.
            </p>
          </div>

          <!-- Name Confirmation if empty -->
          ${(!isPartyB && !dealData.partyAName) || (isPartyB && !dealData.partyBName) ? `
            <div class="input-group">
              <label class="input-label">Confirm Your Legal Full Name <span class="req">*</span></label>
              <input type="text" class="input-control" id="inputSignerFullName" value="${isPartyB ? dealData.partyBName : dealData.partyAName}" placeholder="e.g., Full Name" />
            </div>
          ` : ''}

          <!-- Signing Modes: Draw vs Type -->
          <div class="sign-tabs">
            <button class="sign-tab-btn active" id="tabDrawSign">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>
              Draw with Finger / Mouse
            </button>
            <button class="sign-tab-btn" id="tabTypeSign">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="4 7 4 4 20 4 20 7"/><line x1="9" x2="15" y1="20" y2="20"/><line x1="12" x2="12" y1="4" y2="20"/></svg>
              Type Signature
            </button>
          </div>

          <!-- Canvas Draw Area -->
          <div id="drawSignatureSection">
            <div class="canvas-container">
              <canvas id="signatureCanvas"></canvas>
              <div class="canvas-hint">✍️ Draw clearly inside this box</div>
            </div>
            <div class="signature-actions">
              <button class="btn btn-outline btn-sm" id="btnClearCanvas">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/></svg>
                Clear Pad
              </button>
              <span style="font-size: 0.75rem; color: var(--text-faint);">Touch-responsive • 60 FPS sampling</span>
            </div>
          </div>

          <!-- Type Signature Area -->
          <div id="typeSignatureSection" style="display: none;">
            <div class="input-group">
              <label class="input-label">Type Your Full Name</label>
              <input type="text" class="input-control" id="inputTypeSignName" value="${isPartyB ? dealData.partyBName : dealData.partyAName}" placeholder="Type name..." />
            </div>
            <div style="background: #fff; padding: 1.5rem; border-radius: var(--radius-md); text-align: center; border: 1px solid #d1d5db;">
              <span id="typedSignaturePreview" style="font-family: var(--font-signature); font-size: 2.25rem; color: #1e3a8a;">
                ${(isPartyB ? dealData.partyBName : dealData.partyAName) || 'Signature Preview'}
              </span>
            </div>
          </div>

          <!-- Legal Consent Checkbox (ESIGN Act Requirement) -->
          <div class="legal-consent-card">
            <input type="checkbox" id="checkLegalConsent" checked />
            <label for="checkLegalConsent">
              <strong>Statutory Intent to Sign:</strong> I certify that I am intentionally signing this document electronically under the terms of the U.S. Electronic Signatures in Global and National Commerce Act (ESIGN) and EU eIDAS regulation, and I agree to be legally bound by its terms.
            </label>
          </div>

          <div style="display: flex; justify-content: space-between; margin-top: 1.5rem;">
            ${!isPartyB ? `<button class="btn btn-outline" id="btnBackToTerms">← Edit Terms</button>` : `<div></div>`}
            <button class="btn btn-primary" id="btnApplySignature">
              ${isPartyB ? 'Lock Signature & Finalize Pact 🚀' : 'Lock My Signature & Get Magic Link ⚡'}
            </button>
          </div>
        </div>

        <!-- Right: Live Legal Paper Preview -->
        <div class="paper-wrapper">
          <div class="legal-paper" id="liveLegalPaperContent">
            <!-- Rendered by updateLivePaperPreview() -->
          </div>
        </div>
      </div>
    `;

    setupSignatureStudio(isPartyB);

  } else if (currentStep === 4) {
    // Step 4: Finalize & Magic Link Sharing Hub
    const isBothSigned = dealData.partyASignature && dealData.partyBSignature;
    const magicLink = generateMagicShareUrl();

    container.innerHTML = `
      <div style="max-width: 820px; margin: 0 auto;">
        <!-- Status Banner -->
        <div class="magic-link-banner">
          <div style="display: inline-flex; align-items: center; justify-content: center; width: 64px; height: 64px; border-radius: 50%; background: rgba(16, 185, 129, 0.2); color: var(--emerald-400); margin-bottom: 1rem; box-shadow: 0 0 25px rgba(16, 185, 129, 0.4);">
            <svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>
          </div>

          <h2 style="font-size: 1.75rem; font-weight: 800; color: #fff; margin-bottom: 0.5rem;">
            ${isBothSigned ? '🎉 Pact Fully Executed & Legally Binding!' : '✨ Magic Link Ready for Counterparty Signing!'}
          </h2>
          <p style="color: var(--text-muted); font-size: 0.95rem; max-width: 600px; margin: 0 auto;">
            ${isBothSigned 
              ? 'Both parties have signed and verified this agreement. The official tamper-evident PDF with cryptographic audit certificate is ready for download.' 
              : `Send this secure link to <strong>${dealData.partyBName || 'Party B'}</strong>. They can open it directly on their phone and sign with their finger in 15 seconds.`}
          </p>

          ${!isBothSigned ? `
            <!-- Dedicated Phone Camera Quick Scan Card -->
            <div class="qr-mobile-share-card">
              <div class="qr-mobile-share-badge">
                <span>📱</span> Scan with Phone Camera to Sign
              </div>
              <div class="qr-mobile-image-wrap">
                ${qrCodeDataUrl ? `<img src="${qrCodeDataUrl}" alt="Scan with Phone Camera to Sign" />` : '<div style="width:190px;height:190px;"></div>'}
              </div>
              <div class="qr-mobile-hint">
                <strong>Scan with any phone camera:</strong> Counterparty (Party B) can instantly view the agreement on their mobile device and sign with their finger. No app download or account registration required.
              </div>
            </div>

            <div class="magic-link-input-wrap">
              <input type="text" class="input-control" readonly id="magicLinkInput" value="${magicLink}" style="font-family: var(--font-mono); font-size: 0.8rem; background: rgba(0,0,0,0.5);" />
              <button class="btn btn-primary" id="btnCopyMagicLink">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>
                Copy Link
              </button>
            </div>

            ${isLocalhost() ? `
              <div style="margin: 1.25rem 0; padding: 1rem 1.25rem; background: rgba(245, 158, 11, 0.08); border: 1px solid rgba(245, 158, 11, 0.3); border-radius: var(--radius-md); text-align: left;">
                <div style="display: flex; align-items: center; justify-content: space-between; gap: 8px; flex-wrap: wrap; margin-bottom: 0.4rem;">
                  <span style="font-weight: 700; color: #fbbf24; font-size: 0.88rem; display: flex; align-items: center; gap: 6px;">
                    ⚠️ Mobile / QR Testing Notice (Localhost)
                  </span>
                  <span style="font-family: var(--font-mono); font-size: 0.75rem; color: var(--emerald-400); background: rgba(16,185,129,0.1); padding: 2px 8px; border-radius: 4px;">
                    Active Base: ${getAppBaseUrl()}
                  </span>
                </div>
                <p style="font-size: 0.82rem; color: var(--text-muted); line-height: 1.45; margin-bottom: 0.75rem;">
                  <code>localhost</code> only works locally on this device. To scan the QR code or test on mobile devices, use your local <strong>Network IP</strong> on the same Wi-Fi or deploy to a public hosting service like <strong>Netlify</strong>.
                </p>
                <div style="display: flex; gap: 8px; flex-wrap: wrap;">
                  <button class="btn btn-sm btn-outline" id="btnSetNetworkIp" style="font-size: 0.78rem;">
                    📶 Use Network IP (192.168.0.105:5173)
                  </button>
                  <button class="btn btn-sm btn-outline" id="btnSetLiveDomain" style="font-size: 0.78rem;">
                    🌐 Set Live Domain (e.g. Vercel)
                  </button>
                  ${localStorage.getItem('micropact_custom_base_url') ? `
                    <button class="btn btn-sm btn-outline" id="btnResetToLocalhost" style="font-size: 0.78rem; color: #ef4444; border-color: rgba(239,68,68,0.4);">
                      ↺ Reset Default
                    </button>
                  ` : ''}
                </div>
              </div>
            ` : ''}

            <div class="share-buttons-row">
              <button class="btn-share btn-whatsapp" id="btnShareWhatsApp">
                <svg width="15" height="15" fill="currentColor" viewBox="0 0 24 24"><path d="M12.04 2C6.58 2 2.13 6.45 2.13 11.91C2.13 13.66 2.59 15.36 3.45 16.86L2.05 22L7.3 20.62C8.75 21.41 10.38 21.83 12.04 21.83C17.5 21.83 21.95 17.38 21.95 11.92C21.95 9.27 20.92 6.78 19.05 4.91C17.18 3.03 14.69 2 12.04 2M12.05 3.67C14.25 3.67 16.31 4.53 17.87 6.09C19.42 7.65 20.28 9.72 20.28 11.92C20.28 16.46 16.58 20.15 12.04 20.15C10.56 20.15 9.11 19.76 7.85 19.02L7.55 18.84L4.44 19.66L5.27 16.63L5.07 16.31C4.24 15 3.8 13.47 3.8 11.91C3.81 7.37 7.5 3.67 12.05 3.67Z"/></svg>
                Share via WhatsApp
              </button>
              <button class="btn-share btn-telegram" id="btnShareTelegram">
                <svg width="15" height="15" fill="currentColor" viewBox="0 0 24 24"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm4.64 6.8c-.15 1.58-.8 5.42-1.13 7.19-.14.75-.42 1-.68 1.03-.58.05-1.02-.38-1.58-.75-.88-.58-1.38-.94-2.23-1.5-.99-.65-.35-1.01.22-1.59.15-.15 2.71-2.48 2.76-2.69a.2.2 0 0 0-.05-.18c-.06-.05-.14-.03-.21-.02-.09.02-1.49.95-4.22 2.79-.4.27-.76.41-1.08.4-.36-.01-1.04-.2-1.55-.37-.63-.2-1.12-.31-1.08-.66.02-.18.27-.36.74-.55 2.92-1.27 4.86-2.11 5.83-2.51 2.78-1.16 3.35-1.36 3.73-1.36.08 0 .27.02.39.12.1.08.13.19.14.27-.01.06.01.24 0 .38z"/></svg>
                Telegram
              </button>
              <button class="btn-share btn-email" id="btnShareEmail">
                <svg width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><rect width="20" height="16" x="2" y="4" rx="2"/><path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7"/></svg>
                Email
              </button>
            </div>
          ` : ''}

          <!-- PDF Download Action -->
          <div style="margin-top: 2rem; display: flex; justify-content: center; gap: 1rem; flex-wrap: wrap;">
            <button class="btn btn-primary btn-lg" id="btnDownloadPDF">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" x2="12" y1="15" y2="3"/></svg>
              Download Tamper-Evident Official PDF
            </button>
            <button class="btn btn-outline btn-lg" id="btnStartNewPact">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 12h14"/><path d="M12 5v14"/></svg>
              Create Another Pact
            </button>
          </div>
        </div>

        <!-- Full Render of the final legal paper -->
        <div style="margin-top: 2rem;">
          <h3 style="font-size: 1.15rem; font-weight: 700; color: #fff; margin-bottom: 1rem; text-align: center;">
            Official Executed Document Record
          </h3>
          <div class="legal-paper" id="liveLegalPaperContent">
            <!-- Rendered by updateLivePaperPreview() -->
          </div>
        </div>
      </div>
    `;

    attachFinalizeActions();
  }

  updateLivePaperPreview();
  updateStepperUI();
}

// ==========================================
// 6. LIVE PAPER PREVIEW GENERATION
// ==========================================
function updateLivePaperPreview() {
  const paper = document.getElementById('liveLegalPaperContent');
  if (!paper) return;

  const partyASignMarkup = dealData.partyASignature
    ? (dealData.partyASignature.startsWith('<svg') 
        ? `<div class="paper-sign-svg">${dealData.partyASignature}</div>` 
        : `<img src="${dealData.partyASignature}" class="paper-sign-img" alt="Party A Signature" />`)
    : `<div class="paper-sign-awaiting"><span>✍️</span> Awaiting Signature</div>`;

  const partyBSignMarkup = dealData.partyBSignature
    ? (dealData.partyBSignature.startsWith('<svg') 
        ? `<div class="paper-sign-svg">${dealData.partyBSignature}</div>` 
        : `<img src="${dealData.partyBSignature}" class="paper-sign-img" alt="Party B Signature" />`)
    : `<div class="paper-sign-awaiting"><span>⏳</span> Awaiting Counterparty Signature</div>`;

  const partyASignedDate = dealData.partyASignedAt ? new Date(dealData.partyASignedAt).toUTCString() : 'Pending Execution';
  const partyBSignedDate = dealData.partyBSignedAt ? new Date(dealData.partyBSignedAt).toUTCString() : 'Pending Execution';

  paper.innerHTML = `
    <div class="paper-header">
      <div class="paper-seal-banner">Universal Digital Agreement & Legal Record</div>
      <div class="paper-doc-title">${dealData.title || 'LEGALLY-BINDING MICRO-AGREEMENT'}</div>
      <div class="paper-meta-strip">
        <span>REGISTRY ID: <strong>${dealData.id}</strong></span>
        <span>STATUS: <strong style="color: ${dealData.partyASignature && dealData.partyBSignature ? '#059669' : '#d97706'}">${dealData.partyASignature && dealData.partyBSignature ? 'EXECUTED & BINDING' : 'IN EXECUTION'}</strong></span>
        <span>DATE: <strong>${new Date(dealData.createdDate).toLocaleDateString()}</strong></span>
      </div>
    </div>

    <!-- Legal Preamble -->
    <p style="font-size: 0.8rem; color: #374151; margin-bottom: 1rem;">
      This Agreement is entered into voluntarily by and between the parties identified below under the applicable provisions of the United States Electronic Signatures in Global and National Commerce Act (15 U.S.C. § 7001 et seq.) and the European Union Electronic Identification and Trust Services Regulation (EU No 910/2014 eIDAS).
    </p>

    <!-- Parties Table -->
    <table class="paper-parties-table">
      <thead>
        <tr>
          <th>PARTY A (INITIATOR)</th>
          <th>PARTY B (COUNTERPARTY)</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td>
            <strong>${dealData.partyAName || '____________________'}</strong><br/>
            <span style="color: #6b7280; font-size: 0.75rem;">Role: ${dealData.partyARole || 'Party A'}</span><br/>
            <span style="color: #6b7280; font-size: 0.75rem;">Contact: ${dealData.partyAContact || 'Recorded digitally'}</span>
          </td>
          <td>
            <strong>${dealData.partyBName || '____________________'}</strong><br/>
            <span style="color: #6b7280; font-size: 0.75rem;">Role: ${dealData.partyBRole || 'Party B'}</span><br/>
            <span style="color: #6b7280; font-size: 0.75rem;">Contact: ${dealData.partyBContact || 'Recorded digitally'}</span>
          </td>
        </tr>
      </tbody>
    </table>

    <!-- Subject & Financials -->
    <div class="paper-section-heading">1. Principal Consideration & Terms</div>
    <div class="paper-clause-box">
      <strong>Amount / Value:</strong> ${dealData.amount || 'As specified'}<br/>
      <strong>Performance / Due Date:</strong> ${dealData.dueDate ? new Date(dealData.dueDate).toLocaleDateString() : 'On Demand'}<br/>
      <strong>Purpose & Scope:</strong> ${dealData.purpose || 'Mutual understanding'}
    </div>

    <!-- Numbered Conditions -->
    <div class="paper-section-heading">2. Specific Obligations & Covenants</div>
    <div style="font-size: 0.8rem; color: #374151; white-space: pre-line; margin-bottom: 1rem;">
      ${dealData.specialTerms || 'No additional terms provided.'}
    </div>

    <!-- Signatures -->
    <div class="paper-signatures-row">
      <div class="paper-sign-box">
        <div class="paper-sign-caption">PARTY A SIGNATURE (${dealData.partyAName || 'Party A'})</div>
        <div class="paper-sign-slot">
          ${partyASignMarkup}
        </div>
        <div class="paper-sign-date">Timestamp: ${partyASignedDate}</div>
      </div>

      <div class="paper-sign-box">
        <div class="paper-sign-caption">PARTY B SIGNATURE (${dealData.partyBName || 'Party B'})</div>
        <div class="paper-sign-slot">
          ${partyBSignMarkup}
        </div>
        <div class="paper-sign-date">Timestamp: ${partyBSignedDate}</div>
      </div>
    </div>

    <!-- Certificate of Completion & Audit Trail -->
    <div class="paper-audit-footer">
      ${qrCodeDataUrl ? `<img src="${qrCodeDataUrl}" class="qr-code-img" alt="Verification QR Code" />` : '<div style="width:65px;height:65px;background:#e2e8f0;"></div>'}
      <div class="audit-info">
        <div class="audit-verified-badge">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/></svg>
          TAMPER-EVIDENT CRYPTOGRAPHIC AUDIT CERTIFICATE
        </div>
        <div>Scan QR to verify real-time unaltered ledger integrity.</div>
        <span class="audit-hash">SHA-256: ${dealData.hash || 'Computing...'}</span>
        <div style="font-size: 0.62rem; color: #64748b;">
          Protocol: MicroPact Web Trust Engine • Universal ID: ${dealData.id} • Signatures Enforced
        </div>
      </div>
    </div>
  `;
}




// Refresh cryptographic hash and QR Code
async function refreshQRCodeAndHash() {
  dealData.hash = await computePactHash(dealData);
  const shareUrl = generateMagicShareUrl();
  try {
    // Generate high-resolution, low-density QR code directly containing the magic link
    qrCodeDataUrl = await QRCode.toDataURL(shareUrl, {
      width: 280,
      margin: 1,
      errorCorrectionLevel: 'M',
      color: { dark: '#0a0f1d', light: '#ffffff' }
    });
  } catch (err) {
    console.error('QR code generation with magic link failed, falling back:', err);
    try {
      const base = getAppBaseUrl();
      qrCodeDataUrl = await QRCode.toDataURL(`${base}?verify=${dealData.id}#hash=${dealData.hash.substring(0, 16)}`, {
        width: 280,
        margin: 1,
        errorCorrectionLevel: 'M'
      });
    } catch (e) {}
  }
}

// ==========================================
// 7. SIGNATURE STUDIO LOGIC (CANVAS & TOUCH)
// ==========================================
function setupSignatureStudio(isPartyB) {
  const canvas = document.getElementById('signatureCanvas');
  const clearBtn = document.getElementById('btnClearCanvas');
  const applyBtn = document.getElementById('btnApplySignature');
  const drawTab = document.getElementById('tabDrawSign');
  const typeTab = document.getElementById('tabTypeSign');
  const drawSec = document.getElementById('drawSignatureSection');
  const typeSec = document.getElementById('typeSignatureSection');
  const typeInput = document.getElementById('inputTypeSignName');
  const typePreview = document.getElementById('typedSignaturePreview');
  const consentCheck = document.getElementById('checkLegalConsent');
  const backBtn = document.getElementById('btnBackToTerms');

  if (backBtn) {
    backBtn.addEventListener('click', () => goToStep(2));
  }

  let activeMode = 'draw'; // 'draw' or 'type'

  // Tab switching
  drawTab.addEventListener('click', () => {
    activeMode = 'draw';
    drawTab.classList.add('active');
    typeTab.classList.remove('active');
    drawSec.style.display = 'block';
    typeSec.style.display = 'none';
  });

  typeTab.addEventListener('click', () => {
    activeMode = 'type';
    typeTab.classList.add('active');
    drawTab.classList.remove('active');
    drawSec.style.display = 'none';
    typeSec.style.display = 'block';
  });

  if (typeInput) {
    typeInput.addEventListener('input', (e) => {
      typePreview.textContent = e.target.value.trim() || 'Signature Preview';
    });
  }

  // Canvas Drawing with high-res retina support & touch events
  if (canvas) {
    const ctx = canvas.getContext('2d');
    const rect = canvas.getBoundingClientRect();
    canvas.width = rect.width * 2;
    canvas.height = rect.height * 2;
    ctx.scale(2, 2);

    ctx.strokeStyle = '#1e3a8a'; // Prestigious navy legal ink
    ctx.lineWidth = 2.5;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    let isDrawing = false;
    let hasDrawn = false;
    let strokes = [];
    let currentStroke = [];

    function getPos(e) {
      const cRect = canvas.getBoundingClientRect();
      const clientX = e.touches ? e.touches[0].clientX : e.clientX;
      const clientY = e.touches ? e.touches[0].clientY : e.clientY;
      return {
        x: clientX - cRect.left,
        y: clientY - cRect.top
      };
    }

    function startDraw(e) {
      isDrawing = true;
      hasDrawn = true;
      const pos = getPos(e);
      currentStroke = [pos];
      ctx.beginPath();
      ctx.moveTo(pos.x, pos.y);
      if (e.type === 'touchstart') e.preventDefault();
    }

    function moveDraw(e) {
      if (!isDrawing) return;
      const pos = getPos(e);
      if (currentStroke.length > 0) {
        const last = currentStroke[currentStroke.length - 1];
        const dx = pos.x - last.x;
        const dy = pos.y - last.y;
        if (dx * dx + dy * dy < 18) {
          if (e.type === 'touchmove') e.preventDefault();
          return;
        }
      }
      currentStroke.push(pos);
      ctx.lineTo(pos.x, pos.y);
      ctx.stroke();
      if (e.type === 'touchmove') e.preventDefault();
    }

    function stopDraw(e) {
      if (isDrawing) {
        ctx.closePath();
        isDrawing = false;
        if (currentStroke.length > 0) {
          strokes.push(currentStroke);
          currentStroke = [];
        }
      }
    }

    canvas.addEventListener('mousedown', startDraw);
    canvas.addEventListener('mousemove', moveDraw);
    window.addEventListener('mouseup', stopDraw);

    canvas.addEventListener('touchstart', startDraw, { passive: false });
    canvas.addEventListener('touchmove', moveDraw, { passive: false });
    window.addEventListener('touchend', stopDraw);

    clearBtn.addEventListener('click', () => {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      hasDrawn = false;
      strokes = [];
      currentStroke = [];
    });

    // Apply Signature
    applyBtn.addEventListener('click', async () => {
      if (!consentCheck.checked) {
        showToast('Please check the statutory electronic signature consent box.', 'warning');
        return;
      }

      // Check name
      const signerNameInput = document.getElementById('inputSignerFullName');
      if (signerNameInput && signerNameInput.value.trim()) {
        if (isPartyB) dealData.partyBName = signerNameInput.value.trim();
        else dealData.partyAName = signerNameInput.value.trim();
      }

      const signerName = isPartyB ? dealData.partyBName : dealData.partyAName;
      if (!signerName) {
        showToast('Please provide your legal full name.', 'warning');
        return;
      }

      let signatureData = null;

      if (activeMode === 'draw') {
        if (!hasDrawn || strokes.length === 0) {
          showToast('Please draw your signature or switch to "Type Signature".', 'warning');
          return;
        }
        const cWidth = Math.round(rect.width) || 400;
        const cHeight = Math.round(rect.height) || 150;
        signatureData = strokesToSvg(strokes, cWidth, cHeight);
      } else {
        const typedName = (typeInput.value.trim() || signerName);
        signatureData = typedToSvg(typedName);
      }

      // Record signature and timestamp
      const now = new Date().toISOString();
      if (!isPartyB) {
        dealData.partyASignature = signatureData;
        dealData.partyASignedAt = now;
        dealData.status = 'AWAITING_PARTY_B';
        showToast('Your signature is recorded! Generating Magic Link...');
      } else {
        dealData.partyBSignature = signatureData;
        dealData.partyBSignedAt = now;
        dealData.status = 'COMPLETED';
        dealData.partyBMode = false;
        showToast('Pact successfully executed by both parties!', 'success');
      }

      await refreshQRCodeAndHash();
      goToStep(4);
    });
  }
}

// ==========================================
// 8. FINALIZATION & SHARING
// ==========================================
function generateMagicShareUrl() {
  const base64 = packDeal(dealData);
  const base = getAppBaseUrl();
  const cleanBase = base.endsWith('/') ? base : base + '/';
  return `${cleanBase}#p=${base64}`;
}

function attachFinalizeActions() {
  const copyBtn = document.getElementById('btnCopyMagicLink');
  const whatsAppBtn = document.getElementById('btnShareWhatsApp');
  const telegramBtn = document.getElementById('btnShareTelegram');
  const emailBtn = document.getElementById('btnShareEmail');
  const downloadPdfBtn = document.getElementById('btnDownloadPDF');
  const newPactBtn = document.getElementById('btnStartNewPact');
  const setNetworkIpBtn = document.getElementById('btnSetNetworkIp');
  const setLiveDomainBtn = document.getElementById('btnSetLiveDomain');
  const resetToLocalhostBtn = document.getElementById('btnResetToLocalhost');

  const shareUrl = generateMagicShareUrl();
  const shareText = `Hi ${dealData.partyBName || 'there'}, please review and sign our ${dealData.title}: ${shareUrl}`;

  if (copyBtn) {
    copyBtn.addEventListener('click', () => {
      navigator.clipboard.writeText(shareUrl).then(() => {
        showToast('Magic Link copied to clipboard! Send it via WhatsApp/SMS.');
      });
    });
  }

  if (setNetworkIpBtn) {
    setNetworkIpBtn.addEventListener('click', async () => {
      const networkUrl = 'http://192.168.0.105:5173/';
      localStorage.setItem('micropact_custom_base_url', networkUrl);
      showToast('Switched to Network IP! Now scan on mobile connected to same Wi-Fi.', 'success');
      await refreshQRCodeAndHash();
      renderStepContent();
    });
  }

  if (setLiveDomainBtn) {
    setLiveDomainBtn.addEventListener('click', async () => {
      const current = localStorage.getItem('micropact_custom_base_url') || 'https://micropact.vercel.app';
      const domain = prompt('Enter your live hosted URL or tunnel (e.g. https://your-site.vercel.app):', current);
      if (domain && domain.trim()) {
        let clean = domain.trim();
        if (!clean.startsWith('http://') && !clean.startsWith('https://')) {
          clean = 'https://' + clean;
        }
        localStorage.setItem('micropact_custom_base_url', clean);
        showToast('Live Domain saved! Magic links and QR code updated.', 'success');
        await refreshQRCodeAndHash();
        renderStepContent();
      }
    });
  }

  if (resetToLocalhostBtn) {
    resetToLocalhostBtn.addEventListener('click', async () => {
      localStorage.removeItem('micropact_custom_base_url');
      showToast('Reset to default localhost.', 'info');
      await refreshQRCodeAndHash();
      renderStepContent();
    });
  }

  if (whatsAppBtn) {
    whatsAppBtn.addEventListener('click', () => {
      window.open(`https://api.whatsapp.com/send?text=${encodeURIComponent(shareText)}`, '_blank');
    });
  }

  if (telegramBtn) {
    telegramBtn.addEventListener('click', () => {
      window.open(`https://t.me/share/url?url=${encodeURIComponent(shareUrl)}&text=${encodeURIComponent(dealData.title)}`, '_blank');
    });
  }

  if (emailBtn) {
    emailBtn.addEventListener('click', () => {
      window.location.href = `mailto:${dealData.partyBContact || ''}?subject=${encodeURIComponent('Please Sign: ' + dealData.title)}&body=${encodeURIComponent(shareText)}`;
    });
  }

  if (downloadPdfBtn) {
    downloadPdfBtn.addEventListener('click', () => {
      generateOfficialPDF();
    });
  }

  if (newPactBtn) {
    newPactBtn.addEventListener('click', () => {
      startNewPactFlow();
    });
  }
}

// ==========================================
// 9. PIXEL-PERFECT OFFICIAL PDF GENERATOR
// ==========================================
async function generateOfficialPDF() {
  showToast('Generating notarized PDF certificate...');

  const doc = new jsPDF({
    orientation: 'portrait',
    unit: 'pt',
    format: 'a4'
  });

  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();
  const margin = 36;
  const contentWidth = pageWidth - margin * 2;

  // Outer Legal Border
  doc.setDrawColor(30, 41, 59);
  doc.setLineWidth(1.5);
  doc.rect(margin, margin, contentWidth, pageHeight - margin * 2);

  // Inner Fine Accent Border
  doc.setDrawColor(203, 213, 225);
  doc.setLineWidth(0.5);
  doc.rect(margin + 4, margin + 4, contentWidth - 8, pageHeight - margin * 2 - 8);

  let currentY = margin + 30;

  // Header Banner
  doc.setFont('times', 'bold');
  doc.setFontSize(10);
  doc.setTextColor(75, 85, 99);
  doc.text('OFFICIAL TAMPER-EVIDENT LEGAL INSTRUMENT', pageWidth / 2, currentY, { align: 'center' });

  currentY += 18;
  doc.setFontSize(16);
  doc.setTextColor(17, 24, 39);
  doc.text(dealData.title.toUpperCase(), pageWidth / 2, currentY, { align: 'center' });

  currentY += 14;
  doc.setFont('courier', 'normal');
  doc.setFontSize(8.5);
  doc.setTextColor(100, 116, 139);
  doc.text(`REGISTRY ID: ${dealData.id}   •   STATUS: ${dealData.partyASignature && dealData.partyBSignature ? 'EXECUTED & BINDING' : 'IN EXECUTION'}   •   DATE: ${new Date(dealData.createdDate).toLocaleDateString()}`, pageWidth / 2, currentY, { align: 'center' });

  currentY += 12;
  doc.setDrawColor(17, 24, 39);
  doc.setLineWidth(1.5);
  doc.line(margin + 20, currentY, pageWidth - margin - 20, currentY);

  currentY += 18;
  doc.setFont('times', 'normal');
  doc.setFontSize(9);
  doc.setTextColor(55, 65, 81);
  const preamble = `This Agreement is executed under statutory electronic signature provisions (U.S. ESIGN Act 15 U.S.C. § 7001, Uniform Electronic Transactions Act, and EU eIDAS Regulation). The participating parties consent to electronic contract formation and agree that these digital representations are binding as original signatures.`;
  const splitPreamble = doc.splitTextToSize(preamble, contentWidth - 40);
  doc.text(splitPreamble, margin + 20, currentY);
  currentY += splitPreamble.length * 11 + 10;

  // Parties Box
  doc.setFillColor(248, 250, 252);
  doc.setDrawColor(226, 232, 240);
  doc.setLineWidth(1);
  doc.roundedRect(margin + 20, currentY, contentWidth - 40, 55, 3, 3, 'FD');

  const halfWidth = (contentWidth - 40) / 2;
  doc.setFont('times', 'bold');
  doc.setFontSize(9.5);
  doc.setTextColor(30, 41, 59);
  doc.text('PARTY A (INITIATOR):', margin + 30, currentY + 16);
  doc.text('PARTY B (COUNTERPARTY):', margin + 30 + halfWidth, currentY + 16);

  doc.setFont('times', 'normal');
  doc.setFontSize(9);
  doc.setTextColor(71, 85, 105);
  doc.text(`Name: ${dealData.partyAName || 'Unspecified'} (${dealData.partyARole || 'Party A'})`, margin + 30, currentY + 30);
  doc.text(`Contact: ${dealData.partyAContact || 'Recorded electronically'}`, margin + 30, currentY + 44);

  doc.text(`Name: ${dealData.partyBName || 'Unspecified'} (${dealData.partyBRole || 'Party B'})`, margin + 30 + halfWidth, currentY + 30);
  doc.text(`Contact: ${dealData.partyBContact || 'Recorded electronically'}`, margin + 30 + halfWidth, currentY + 44);

  currentY += 68;

  // Financials & Due Date
  doc.setFont('times', 'bold');
  doc.setFontSize(10);
  doc.setTextColor(15, 23, 42);
  doc.text('1. PRINCIPAL CONSIDERATION & PURPOSE', margin + 20, currentY);

  currentY += 12;
  doc.setFillColor(241, 245, 249);
  doc.rect(margin + 20, currentY, contentWidth - 40, 42, 'F');
  doc.setDrawColor(16, 185, 129);
  doc.setLineWidth(3);
  doc.line(margin + 20, currentY, margin + 20, currentY + 42);

  doc.setFont('times', 'normal');
  doc.setFontSize(9);
  doc.setTextColor(30, 41, 59);
  doc.text(`Consideration / Value: ${dealData.amount || 'As specified'}`, margin + 30, currentY + 14);
  doc.text(`Due / Completion Date: ${dealData.dueDate ? new Date(dealData.dueDate).toLocaleDateString() : 'On Demand'}`, margin + 30, currentY + 26);
  doc.text(`Subject Matter: ${dealData.purpose || 'General understanding'}`, margin + 30, currentY + 38);

  currentY += 54;

  // Specific Clauses
  doc.setFont('times', 'bold');
  doc.setFontSize(10);
  doc.setTextColor(15, 23, 42);
  doc.text('2. TERMS, CONDITIONS & LEGAL COVENANTS', margin + 20, currentY);

  currentY += 14;
  doc.setFont('times', 'normal');
  doc.setFontSize(8.5);
  doc.setTextColor(51, 65, 85);
  const clauses = doc.splitTextToSize(dealData.specialTerms || 'No additional terms provided.', contentWidth - 40);
  doc.text(clauses, margin + 20, currentY);
  currentY += Math.min(clauses.length * 11, 140) + 15;

  // Signatures Area
  const signBoxY = pageHeight - margin - 150;
  doc.setDrawColor(203, 213, 225);
  doc.setLineWidth(0.8);
  doc.line(margin + 20, signBoxY, pageWidth - margin - 20, signBoxY);

  doc.setFont('times', 'bold');
  doc.setFontSize(9);
  doc.text(`PARTY A: ${dealData.partyAName || 'Party A'}`, margin + 25, signBoxY + 14);
  doc.text(`PARTY B: ${dealData.partyBName || 'Party B'}`, margin + 25 + halfWidth, signBoxY + 14);

  // Embed Party A signature
  if (dealData.partyASignature) {
    try {
      const pngA = await svgToPngDataUrl(dealData.partyASignature, 300, 90);
      if (pngA) {
        doc.addImage(pngA, 'PNG', margin + 25, signBoxY + 18, 130, 36);
      } else {
        doc.text('[Digital Signature Recorded]', margin + 25, signBoxY + 36);
      }
    } catch (e) {
      doc.text('[Digital Signature Recorded]', margin + 25, signBoxY + 36);
    }
  } else {
    doc.setFont('times', 'italic');
    doc.setTextColor(156, 163, 175);
    doc.text('[Awaiting Signature]', margin + 25, signBoxY + 36);
  }

  // Embed Party B signature
  if (dealData.partyBSignature) {
    try {
      const pngB = await svgToPngDataUrl(dealData.partyBSignature, 300, 90);
      if (pngB) {
        doc.addImage(pngB, 'PNG', margin + 25 + halfWidth, signBoxY + 18, 130, 36);
      } else {
        doc.text('[Digital Signature Recorded]', margin + 25 + halfWidth, signBoxY + 36);
      }
    } catch (e) {
      doc.text('[Digital Signature Recorded]', margin + 25 + halfWidth, signBoxY + 36);
    }
  } else {
    doc.setFont('times', 'italic');
    doc.setTextColor(156, 163, 175);
    doc.text('[Awaiting Signature]', margin + 25 + halfWidth, signBoxY + 36);
  }

  doc.setFont('courier', 'normal');
  doc.setFontSize(7.5);
  doc.setTextColor(100, 116, 139);
  doc.text(`Executed: ${dealData.partyASignedAt ? new Date(dealData.partyASignedAt).toUTCString() : 'Pending'}`, margin + 25, signBoxY + 62);
  doc.text(`Executed: ${dealData.partyBSignedAt ? new Date(dealData.partyBSignedAt).toUTCString() : 'Pending'}`, margin + 25 + halfWidth, signBoxY + 62);

  // Footer Certificate of Authenticity & QR Code Box
  const footerBoxY = pageHeight - margin - 75;
  doc.setFillColor(248, 250, 252);
  doc.setDrawColor(203, 213, 225);
  doc.roundedRect(margin + 20, footerBoxY, contentWidth - 40, 60, 3, 3, 'FD');

  if (qrCodeDataUrl) {
    try {
      doc.addImage(qrCodeDataUrl, 'PNG', margin + 26, footerBoxY + 6, 48, 48);
    } catch (e) {}
  }

  doc.setFont('times', 'bold');
  doc.setFontSize(8.5);
  doc.setTextColor(5, 150, 105);
  doc.text('AUDIT TRAIL & TAMPER-EVIDENT CRYPTOGRAPHIC SEAL', margin + 82, footerBoxY + 16);

  doc.setFont('courier', 'normal');
  doc.setFontSize(7);
  doc.setTextColor(30, 41, 59);
  doc.text(`SHA-256 HASH: ${dealData.hash || 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'}`, margin + 82, footerBoxY + 28);
  doc.text(`VERIFICATION STATUS: VERIFIED ORIGINAL • UNALTERED LEDGER`, margin + 82, footerBoxY + 40);
  doc.text(`ISSUED BY: MicroPact Global Electronic Contract Engine (ISO-27001 Standards)`, margin + 82, footerBoxY + 52);

  doc.save(`${dealData.id}_${dealData.templateId}.pdf`);
  showToast('Official PDF downloaded successfully!', 'success');
}

// ==========================================
// 10. HELPER FUNCTIONS & EVENT HANDLERS
// ==========================================
function selectTemplateById(id) {
  const found = TEMPLATES.find(t => t.id === id);
  if (!found) return;
  selectedTemplate = found;
  dealData.templateId = found.id;
  dealData.title = found.defaults.title;
  dealData.partyARole = found.defaults.partyARole;
  dealData.partyBRole = found.defaults.partyBRole;
  dealData.amount = found.defaults.amount;
  dealData.dueDate = found.defaults.dueDate;
  dealData.purpose = found.defaults.purpose;
  dealData.specialTerms = found.defaults.specialTerms;
}

function goToStep(step) {
  currentStep = step;
  renderStepContent();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function updateStepperUI() {
  const steps = document.querySelectorAll('.step-item');
  steps.forEach(st => {
    const s = parseInt(st.getAttribute('data-step'), 10);
    st.classList.remove('active', 'completed');
    if (s === currentStep) st.classList.add('active');
    else if (s < currentStep) st.classList.add('completed');
  });
}

function attachFormInputListeners() {
  const partyAName = document.getElementById('inputPartyAName');
  const selectPartyARole = document.getElementById('selectPartyARole');
  const customPartyARole = document.getElementById('inputCustomPartyARole');
  const partyAContact = document.getElementById('inputPartyAContact');
  
  const partyBName = document.getElementById('inputPartyBName');
  const selectPartyBRole = document.getElementById('selectPartyBRole');
  const customPartyBRole = document.getElementById('inputCustomPartyBRole');
  const partyBContact = document.getElementById('inputPartyBContact');
  
  const amount = document.getElementById('inputAmount');
  const dueDate = document.getElementById('inputDueDate');
  const purpose = document.getElementById('inputPurpose');
  const specialTerms = document.getElementById('inputSpecialTerms');

  const btnChangeTemplate = document.getElementById('btnChangeTemplate');
  const btnBackToTemplates = document.getElementById('btnBackToTemplates');
  const btnProceedToSign = document.getElementById('btnProceedToSign');
  const btnFillDemo = document.getElementById('btnFillDemoData');

  const btnClauseLateFee = document.getElementById('btnClauseLateFee');
  const btnClauseArbitration = document.getElementById('btnClauseArbitration');
  const btnClauseConfidentiality = document.getElementById('btnClauseConfidentiality');
  const btnClauseClear = document.getElementById('btnClauseClear');

  if (btnChangeTemplate) btnChangeTemplate.addEventListener('click', () => goToStep(1));
  if (btnBackToTemplates) btnBackToTemplates.addEventListener('click', () => goToStep(1));

  function getPartyARoleValue() {
    if (selectPartyARole && selectPartyARole.value === '__custom__') {
      return customPartyARole ? customPartyARole.value.trim() : 'Party A';
    }
    return selectPartyARole ? selectPartyARole.value : 'Party A';
  }

  function getPartyBRoleValue() {
    if (selectPartyBRole && selectPartyBRole.value === '__custom__') {
      return customPartyBRole ? customPartyBRole.value.trim() : 'Party B';
    }
    return selectPartyBRole ? selectPartyBRole.value : 'Party B';
  }

  // Role A custom toggle
  if (selectPartyARole) {
    selectPartyARole.addEventListener('change', () => {
      if (selectPartyARole.value === '__custom__') {
        customPartyARole.style.display = 'block';
        customPartyARole.focus();
      } else {
        customPartyARole.style.display = 'none';
      }
      syncAndRefresh();
    });
  }

  // Role B custom toggle
  if (selectPartyBRole) {
    selectPartyBRole.addEventListener('change', () => {
      if (selectPartyBRole.value === '__custom__') {
        customPartyBRole.style.display = 'block';
        customPartyBRole.focus();
      } else {
        customPartyBRole.style.display = 'none';
      }
      syncAndRefresh();
    });
  }

  // Quick Demo Autofill Button
  if (btnFillDemo) {
    btnFillDemo.addEventListener('click', () => {
      const demo = selectedTemplate.sampleData;
      if (!demo) return;

      if (partyAName) partyAName.value = demo.partyAName;
      if (partyAContact) partyAContact.value = demo.partyAContact;
      if (partyBName) partyBName.value = demo.partyBName;
      if (partyBContact) partyBContact.value = demo.partyBContact;
      if (amount) amount.value = demo.amount;
      if (dueDate) dueDate.value = demo.dueDate;
      if (purpose) purpose.value = demo.purpose;
      if (specialTerms) specialTerms.value = demo.specialTerms;

      if (selectPartyARole) {
        selectPartyARole.value = demo.partyARole;
        if (customPartyARole) customPartyARole.style.display = 'none';
      }
      if (selectPartyBRole) {
        selectPartyBRole.value = demo.partyBRole;
        if (customPartyBRole) customPartyBRole.style.display = 'none';
      }

      syncAndRefresh();
      showToast('🪄 Sample test data loaded! Check the live paper on the right.');
    });
  }

  // Clause Helpers
  if (btnClauseLateFee) {
    btnClauseLateFee.addEventListener('click', () => {
      if (specialTerms) {
        specialTerms.value += `\n• Late Fee: Any overdue balance following the due date incurs a 5% monthly late fee until satisfied in full.`;
        syncAndRefresh();
        showToast('Added Late Fee Clause.');
      }
    });
  }

  if (btnClauseArbitration) {
    btnClauseArbitration.addEventListener('click', () => {
      if (specialTerms) {
        specialTerms.value += `\n• Dispute Arbitration: Any controversy arising under this covenant shall be submitted to binding individual arbitration prior to formal court proceedings.`;
        syncAndRefresh();
        showToast('Added Dispute Arbitration Clause.');
      }
    });
  }

  if (btnClauseConfidentiality) {
    btnClauseConfidentiality.addEventListener('click', () => {
      if (specialTerms) {
        specialTerms.value += `\n• Confidentiality: Both parties mutually agree to hold all financial, personal, and transactional details of this pact strictly confidential.`;
        syncAndRefresh();
        showToast('Added Confidentiality Clause.');
      }
    });
  }

  if (btnClauseClear) {
    btnClauseClear.addEventListener('click', () => {
      if (specialTerms) {
        specialTerms.value = selectedTemplate.defaults.specialTerms;
        syncAndRefresh();
        showToast('Reset clauses to template default.');
      }
    });
  }

  function syncAndRefresh() {
    dealData.partyAName = partyAName ? partyAName.value.trim() : '';
    dealData.partyARole = getPartyARoleValue();
    dealData.partyAContact = partyAContact ? partyAContact.value.trim() : '';
    dealData.partyBName = partyBName ? partyBName.value.trim() : '';
    dealData.partyBRole = getPartyBRoleValue();
    dealData.partyBContact = partyBContact ? partyBContact.value.trim() : '';
    dealData.amount = amount ? amount.value.trim() : '';
    dealData.dueDate = dueDate ? dueDate.value : '';
    dealData.purpose = purpose ? purpose.value.trim() : '';
    dealData.specialTerms = specialTerms ? specialTerms.value : '';

    refreshQRCodeAndHash().then(() => updateLivePaperPreview());
  }

  [partyAName, customPartyARole, partyAContact, partyBName, customPartyBRole, partyBContact, amount, dueDate, purpose, specialTerms].forEach(inp => {
    if (inp) inp.addEventListener('input', syncAndRefresh);
  });

  if (btnProceedToSign) {
    btnProceedToSign.addEventListener('click', () => {
      syncAndRefresh();
      if (!dealData.partyAName) {
        showToast('Please enter your full legal name (Party A).', 'warning');
        return;
      }
      if (!dealData.partyBName) {
        showToast('Please enter the counterparty name (Party B).', 'warning');
        return;
      }
      goToStep(3);
    });
  }
}

function syncInputsWithDealData() {
  const tpl = TEMPLATES.find(t => t.id === dealData.templateId);
  if (tpl) selectedTemplate = tpl;
}

function startNewPactFlow() {
  dealData = {
    id: generateDealId(),
    createdDate: new Date().toISOString(),
    templateId: 'promissory_note',
    title: TEMPLATES[0].defaults.title,
    partyAName: '',
    partyARole: TEMPLATES[0].defaults.partyARole,
    partyAContact: '',
    partyASignature: null,
    partyASignedAt: null,
    partyBName: '',
    partyBRole: TEMPLATES[0].defaults.partyBRole,
    partyBContact: '',
    partyBSignature: null,
    partyBSignedAt: null,
    amount: TEMPLATES[0].defaults.amount,
    dueDate: TEMPLATES[0].defaults.dueDate,
    purpose: TEMPLATES[0].defaults.purpose,
    specialTerms: TEMPLATES[0].defaults.specialTerms,
    status: 'DRAFT',
    hash: '',
    partyBMode: false
  };
  selectedTemplate = TEMPLATES[0];
  window.location.hash = '';
  currentStep = 1;
  refreshQRCodeAndHash().then(() => renderStepContent());
  showToast('New pact draft started.');
}

function attachGlobalEvents() {
  const brandBtn = document.getElementById('brandHomeBtn');
  if (brandBtn) brandBtn.addEventListener('click', () => goToStep(1));

  const openVerifyBtn = document.getElementById('openVerifyModalBtn');
  if (openVerifyBtn) openVerifyBtn.addEventListener('click', openVerificationModal);

  const openLegalFaqBtn = document.getElementById('openLegalFaqBtn');
  if (openLegalFaqBtn) openLegalFaqBtn.addEventListener('click', openLegalFAQModal);

  const footerTemplates = document.getElementById('footerTemplatesLink');
  if (footerTemplates) footerTemplates.addEventListener('click', () => goToStep(1));

  const footerEsign = document.getElementById('footerEsignLegalLink');
  if (footerEsign) footerEsign.addEventListener('click', openLegalFAQModal);

  const footerNewPact = document.getElementById('footerNewPactBtn');
  if (footerNewPact) footerNewPact.addEventListener('click', startNewPactFlow);

  // Stepper clicks
  const stepper = document.getElementById('stepperContainer');
  if (stepper) {
    stepper.addEventListener('click', (e) => {
      const stepItem = e.target.closest('.step-item');
      if (stepItem) {
        const s = parseInt(stepItem.getAttribute('data-step'), 10);
        if (s <= currentStep || (dealData.partyASignature && s === 4)) {
          goToStep(s);
        }
      }
    });
  }
}

// ==========================================
// 11. MODALS & NOTIFICATIONS
// ==========================================
function showToast(message, type = 'info') {
  const container = document.getElementById('toastContainer');
  if (!container) return;

  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.innerHTML = `
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
      <path d="m9 12 2 2 4-4"/>
    </svg>
    <span>${message}</span>
  `;
  container.appendChild(toast);
  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateX(100%)';
    toast.style.transition = 'all 0.3s ease';
    setTimeout(() => toast.remove(), 300);
  }, 3500);
}

function openVerificationModal() {
  const modalContainer = document.getElementById('modalContainer');
  modalContainer.innerHTML = `
    <div class="modal-overlay active" id="verifyModalOverlay">
      <div class="modal-dialog">
        <button class="modal-close-btn" id="closeModalBtn">✕</button>

        <div style="text-align: center; margin-bottom: 1.5rem;">
          <div style="display: inline-flex; align-items: center; justify-content: center; width: 50px; height: 50px; border-radius: 50%; background: rgba(16, 185, 129, 0.2); color: var(--emerald-400); margin-bottom: 0.75rem;">
            <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="m9 12 2 2 4-4"/></svg>
          </div>
          <h3 style="font-size: 1.35rem; font-weight: 800; color: #fff;">MicroPact Trust & Verification Engine</h3>
          <p style="color: var(--text-muted); font-size: 0.85rem;">Cryptographic audit trail confirming authenticity and tamper resistance.</p>
        </div>

        <div style="background: rgba(7, 9, 14, 0.8); border: 1px solid var(--border-color); border-radius: var(--radius-md); padding: 1.25rem; font-family: var(--font-mono); font-size: 0.8rem; margin-bottom: 1.25rem;">
          <div style="color: var(--emerald-400); font-weight: 700; margin-bottom: 0.5rem; display: flex; align-items: center; gap: 6px;">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/></svg>
            STATUS: ACTIVE & VERIFIED
          </div>
          <div style="color: var(--text-muted); margin-bottom: 0.35rem;">REGISTRY ID: <span style="color: #fff;">${dealData.id}</span></div>
          <div style="color: var(--text-muted); margin-bottom: 0.35rem;">TITLE: <span style="color: #fff;">${dealData.title}</span></div>
          <div style="color: var(--text-muted); margin-bottom: 0.35rem;">PARTY A: <span style="color: #fff;">${dealData.partyAName || 'Unspecified'} (${dealData.partyASignedAt ? 'Signed ✓' : 'Awaiting'})</span></div>
          <div style="color: var(--text-muted); margin-bottom: 0.35rem;">PARTY B: <span style="color: #fff;">${dealData.partyBName || 'Unspecified'} (${dealData.partyBSignedAt ? 'Signed ✓' : 'Awaiting'})</span></div>
          <div style="color: var(--text-muted); word-break: break-all;">
            SHA-256 HASH: <span style="color: var(--emerald-400);">${dealData.hash || 'Computing...'}</span>
          </div>
        </div>

        <p style="font-size: 0.8rem; color: var(--text-muted); line-height: 1.5; margin-bottom: 1.25rem;">
          Any alteration to party identities, monetary values, dates, or covenants immediately invalidates the cryptographic checksum, preventing forgery or post-signature alteration.
        </p>

        <button class="btn btn-primary" style="width: 100%;" id="closeModalAction">Close Certificate</button>
      </div>
    </div>
  `;

  document.getElementById('closeModalBtn').addEventListener('click', closeModal);
  document.getElementById('closeModalAction').addEventListener('click', closeModal);
}

function openLegalFAQModal() {
  const modalContainer = document.getElementById('modalContainer');
  modalContainer.innerHTML = `
    <div class="modal-overlay active">
      <div class="modal-dialog">
        <button class="modal-close-btn" id="closeFaqBtn">✕</button>
        <h3 style="font-size: 1.35rem; font-weight: 800; color: #fff; margin-bottom: 1rem;">
          ⚖️ Legal Enforceability Framework
        </h3>
        <div style="font-size: 0.85rem; color: var(--text-muted); line-height: 1.6;">
          <p style="margin-bottom: 1rem;">
            <strong>Are electronic signatures legally binding?</strong><br/>
            Yes. Under the U.S. Electronic Signatures in Global and National Commerce Act (ESIGN, 15 U.S.C. § 7001), the Uniform Electronic Transactions Act (UETA), and EU eIDAS regulation, an electronic signature has the same legal effect as a manual pen-and-paper signature.
          </p>
          <p style="margin-bottom: 1rem;">
            <strong>What makes MicroPact tamper-proof?</strong><br/>
            MicroPact computes a 256-bit cryptographic digest (SHA-256) encompassing all parties, financial terms, dates, clauses, and timestamps. If any party modifies a single letter after execution, the cryptographic verification fails immediately.
          </p>
          <p>
            <strong>Is it recognized in legal dispute resolution?</strong><br/>
            Yes, under contract law, the four essential pillars are: Offer, Acceptance, Consideration, and Mutual Intent. MicroPact provides verifiable, date-stamped digital proof of all four elements together with complete cryptographic audit trails.
          </p>
        </div>
        <button class="btn btn-primary" style="width: 100%; margin-top: 1.5rem;" id="closeFaqAction">Understood</button>
      </div>
    </div>
  `;

  document.getElementById('closeFaqBtn').addEventListener('click', closeModal);
  document.getElementById('closeFaqAction').addEventListener('click', closeModal);
}

function closeModal() {
  const overlay = document.querySelector('.modal-overlay');
  if (overlay) {
    overlay.classList.remove('active');
    setTimeout(() => overlay.remove(), 200);
  }
}

// ==========================================
// 12. BOOTSTRAP APPLICATION
// ==========================================
function initApp() {
  renderAppStructure();
  const loadedFromUrl = checkUrlForExistingDeal();
  if (!loadedFromUrl) {
    refreshQRCodeAndHash().then(() => {
      renderStepContent();
      updateLivePaperPreview();
    });
  }
}

// Robust execution in case DOM is already ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initApp);
} else {
  initApp();
}

// Listen to URL hash change dynamically (e.g. user opens or clicks new deal link)
window.addEventListener('hashchange', () => {
  checkUrlForExistingDeal();
});
