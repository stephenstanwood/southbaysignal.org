// ---------------------------------------------------------------------------
// South Bay Tech Companies — curated snapshot, Q1 2026
// sccEmployeesK: Santa Clara County local jobs estimate (not global headcount)
// Sources: company filings, campus reports, EDD data, news coverage
// ---------------------------------------------------------------------------

export type TechCategory =
  | "chip"
  | "cloud"
  | "software"
  | "network"
  | "ecommerce"
  | "fintech"
  | "security"
  | "social"
  | "hardware"
  | "saas";

export const CATEGORY_LABELS: Record<TechCategory, string> = {
  chip: "Chips",
  cloud: "Cloud",
  software: "Software",
  network: "Networking",
  ecommerce: "E-Commerce",
  fintech: "Fintech",
  security: "Security",
  social: "Social",
  hardware: "Hardware",
  saas: "SaaS",
};

export type TechTrend = "up" | "flat" | "down";

export interface TechCompany {
  id: string;
  name: string;
  chartName: string; // shorter name for chart axis
  ticker?: string;
  city: string;
  category: TechCategory;
  sccEmployeesK: number; // Santa Clara County local jobs, in thousands (estimated)
  trend: TechTrend;
  trendNote: string;
  highlights: string[];
  description: string;
  color: string; // brand-adjacent color for charts
}

export const TECH_COMPANIES: TechCompany[] = [
  {
    id: "google",
    name: "Google",
    chartName: "Google",
    ticker: "GOOGL",
    city: "Mountain View",
    category: "cloud",
    sccEmployeesK: 25,
    trend: "flat",
    trendNote: "25K at Googleplex + SCC offices; stabilized after 2023 layoffs",
    highlights: [
      "Gemini AI driving search, Cloud, and device integration across all products",
      "Waymo robotaxi service expanding commercially to multiple US cities",
    ],
    description:
      "Search, cloud, AI, and advertising. The largest campus presence in the South Bay.",
    color: "#4285F4",
  },
  {
    id: "apple",
    name: "Apple",
    chartName: "Apple",
    ticker: "AAPL",
    city: "Cupertino",
    category: "hardware",
    sccEmployeesK: 25,
    trend: "flat",
    trendNote: "25K at Apple Park + SCC offices; roughly stable since 2023",
    highlights: [
      "Apple Intelligence on-device AI rolling out across iPhone, Mac, and iPad",
      "M4 chip family in full deployment; Vision Pro second generation rumored",
    ],
    description:
      "Consumer hardware, software, and services. One Apple Park Way, Cupertino.",
    color: "#555555",
  },
  {
    id: "intel",
    name: "Intel",
    chartName: "Intel",
    ticker: "INTC",
    city: "Santa Clara",
    category: "chip",
    sccEmployeesK: 14,
    trend: "down",
    trendNote: "14K in SCC; down sharply after cutting 15K jobs in 2024 restructuring",
    highlights: [
      "CEO Pat Gelsinger resigned December 2024; company charting new course",
      "Intel Foundry Services struggling to win advanced semiconductor orders from outside customers",
    ],
    description:
      "CPU pioneer navigating a major strategic pivot. Once the defining company of Silicon Valley.",
    color: "#0071C5",
  },
  {
    id: "cisco",
    name: "Cisco",
    chartName: "Cisco",
    ticker: "CSCO",
    city: "San Jose",
    category: "network",
    sccEmployeesK: 12,
    trend: "flat",
    trendNote: "12K at SJ HQ + SCC offices; stable following Splunk integration",
    highlights: [
      "Splunk acquisition ($28B) transforms Cisco into a major security + observability platform",
      "Networking hardware and software being repositioned for AI infrastructure demand",
    ],
    description:
      "Enterprise networking, security, and observability. The largest employer in downtown San Jose.",
    color: "#1BA0D7",
  },
  {
    id: "meta",
    name: "Meta",
    chartName: "Meta",
    ticker: "META",
    city: "Menlo Park",
    category: "social",
    sccEmployeesK: 2,
    trend: "up",
    trendNote: "HQ is in San Mateo County; 2K in SCC offices (Sunnyvale, SJ)",
    highlights: [
      "Llama open-source AI models advancing Meta AI across Facebook, Instagram, and WhatsApp",
      "Ray-Ban Meta smart glasses gaining traction as low-key consumer wearable AI",
    ],
    description:
      "Social media, VR/AR, and open-source AI. Menlo Park HQ just over the county line.",
    color: "#0081FB",
  },
  {
    id: "nvidia",
    name: "NVIDIA",
    chartName: "NVIDIA",
    ticker: "NVDA",
    city: "Santa Clara",
    category: "chip",
    sccEmployeesK: 7,
    trend: "up",
    trendNote: "7K at Santa Clara HQ + SCC offices; growing with AI GPU demand",
    highlights: [
      "Blackwell GPU architecture (B100/B200) powering next-generation AI data centers globally",
      "Market cap surpassed $3 trillion — briefly the most valuable company in the world",
    ],
    description:
      "GPUs and AI accelerators. The defining company of the current AI era. Santa Clara's crown jewel.",
    color: "#76B900",
  },
  {
    id: "adobe",
    name: "Adobe",
    chartName: "Adobe",
    ticker: "ADBE",
    city: "San Jose",
    category: "software",
    sccEmployeesK: 5,
    trend: "flat",
    trendNote: "5K at SJ HQ; stable after abandoned $20B Figma acquisition",
    highlights: [
      "Firefly generative AI now integrated throughout Creative Cloud product line",
      "Dropped $20B Figma acquisition in 2023 after regulatory pressure; Figma remains independent",
    ],
    description:
      "Creative software for design, video, and documents. Firefly AI reshaping how creators work.",
    color: "#FF0000",
  },
  {
    id: "paypal",
    name: "PayPal",
    chartName: "PayPal",
    ticker: "PYPL",
    city: "San Jose",
    category: "fintech",
    sccEmployeesK: 5,
    trend: "down",
    trendNote: "5K at SJ HQ; down after cutting 2,500 jobs in 2024 restructuring",
    highlights: [
      "New CEO Alex Chriss refocusing on core checkout experience and Venmo monetization",
      "Fastlane one-click checkout targeting merchant conversion improvement",
    ],
    description:
      "Digital payments and Venmo. Rebuilding focus and momentum after years of stock decline.",
    color: "#003087",
  },
  {
    id: "amd",
    name: "AMD",
    chartName: "AMD",
    ticker: "AMD",
    city: "Santa Clara",
    category: "chip",
    sccEmployeesK: 5,
    trend: "up",
    trendNote: "5K at Santa Clara HQ; growing as MI300X earns data center wins",
    highlights: [
      "MI300X AI GPU positioned as the primary alternative to NVIDIA H100 for AI workloads",
      "EPYC server CPUs dominant across major cloud providers — AWS, Azure, Google Cloud",
    ],
    description:
      "CPUs and GPUs for PCs, servers, and AI. The other chip giant headquartered in Santa Clara.",
    color: "#ED1C24",
  },
  {
    id: "servicenow",
    name: "ServiceNow",
    chartName: "ServiceNow",
    ticker: "NOW",
    city: "Santa Clara",
    category: "saas",
    sccEmployeesK: 6,
    trend: "up",
    trendNote: "6K at Santa Clara HQ; headcount growing with 20%+ revenue growth",
    highlights: [
      "Now Platform AI Agents automating enterprise IT, HR, and customer workflows at scale",
      "One of the fastest-growing large enterprise software companies in the world",
    ],
    description:
      "Enterprise workflow automation. The quiet giant of South Bay SaaS.",
    color: "#62D84E",
  },
  {
    id: "linkedin",
    name: "LinkedIn",
    chartName: "LinkedIn",
    ticker: "MSFT",
    city: "Sunnyvale",
    category: "social",
    sccEmployeesK: 8,
    trend: "flat",
    trendNote: "8K at Sunnyvale HQ; stable under Microsoft ownership",
    highlights: [
      "AI-assisted job matching, writing tools, and profile optimization launching for Premium users",
      "B2B advertising and Premium subscriptions driving revenue growth for Microsoft",
    ],
    description:
      "Professional network and recruiting platform. Microsoft-owned, headquartered in Sunnyvale.",
    color: "#0A66C2",
  },
  {
    id: "juniper",
    name: "Juniper Networks",
    chartName: "Juniper",
    ticker: "HPE",
    city: "Sunnyvale",
    category: "network",
    sccEmployeesK: 3,
    trend: "flat",
    trendNote: "3K at Sunnyvale HQ; now part of HP Enterprise after $14B acquisition",
    highlights: [
      "HP Enterprise acquisition closed 2024 — Juniper now part of HPE networking portfolio",
      "Mist AI-driven networking platform being integrated into HPE product suite",
    ],
    description:
      "Enterprise networking. Now part of HP Enterprise after a $14B acquisition.",
    color: "#84BD00",
  },
  {
    id: "western-digital",
    name: "Western Digital",
    chartName: "W. Digital",
    ticker: "WDC",
    city: "San Jose",
    category: "hardware",
    sccEmployeesK: 4,
    trend: "flat",
    trendNote: "4K at SJ HQ; focused on hard drives after Sandisk spin-off Feb 2025",
    highlights: [
      "Sandisk spin-off completed February 2025 — WD now a focused hard drive company",
      "Hard drive demand rising again with AI data center storage needs driving enterprise sales",
    ],
    description:
      "Data storage hardware. Split off Sandisk to focus on the hard drive business.",
    color: "#CC1414",
  },
  {
    id: "ebay",
    name: "eBay",
    chartName: "eBay",
    ticker: "EBAY",
    city: "San Jose",
    category: "ecommerce",
    sccEmployeesK: 3,
    trend: "flat",
    trendNote: "3K at SJ HQ; focused category strategy stabilizing",
    highlights: [
      "AI-powered listing tools cutting seller friction and improving listing quality significantly",
      "Authenticity Guarantee expanding to more collectible and luxury product categories",
    ],
    description:
      "Online marketplace pioneer. Refocused on enthusiast categories — sneakers, collectibles, luxury.",
    color: "#E53238",
  },
  {
    id: "palo-alto",
    name: "Palo Alto Networks",
    chartName: "Palo Alto",
    ticker: "PANW",
    city: "Santa Clara",
    category: "security",
    sccEmployeesK: 4,
    trend: "up",
    trendNote: "4K at Santa Clara HQ; growing with security platform consolidation wins",
    highlights: [
      "'Platformization' strategy winning large enterprise security consolidation deals from point-product vendors",
      "Precision AI features now embedded across the full security product portfolio",
    ],
    description:
      "Cybersecurity platform. One of the fastest-growing security companies in the world.",
    color: "#FA582D",
  },
  {
    id: "zoom",
    name: "Zoom",
    chartName: "Zoom",
    ticker: "ZM",
    city: "San Jose",
    category: "saas",
    sccEmployeesK: 2,
    trend: "flat",
    trendNote: "2K at SJ HQ; post-pandemic normalization, pivoting to AI Companion",
    highlights: [
      "Zoom Workplace platform adds AI Companion for meeting summaries and conversation intelligence",
      "Adapting to hybrid work normalization after extraordinary pandemic-era growth period",
    ],
    description:
      "Video meetings and workplace collaboration. A COVID-era breakout finding its steady state.",
    color: "#2D8CFF",
  },
];

// Top employers sorted for chart (top 10 by SCC employment)
export const CHART_DATA = [...TECH_COMPANIES]
  .sort((a, b) => b.sccEmployeesK - a.sccEmployeesK)
  .slice(0, 10)
  .map((c) => ({
    name: c.chartName,
    headcount: c.sccEmployeesK,
    color: c.color,
    trend: c.trend,
  }));

// ---------------------------------------------------------------------------
// More SCC tech companies — mid-size established + notable startups
// ---------------------------------------------------------------------------

export interface SccTechSpotlight {
  id: string;
  name: string;
  city: string;
  category: TechCategory | "medtech" | "eda";
  stage: "public" | "startup" | "growth";
  tagline: string;
  color: string;
  url: string;
  employeesNote: string; // e.g. "18K employees globally" or "500 employees"
}

export const SCC_SPOTLIGHT: SccTechSpotlight[] = [
  {
    id: "intuit",
    name: "Intuit",
    city: "Mountain View",
    category: "software",
    stage: "public",
    tagline: "TurboTax, QuickBooks, and Credit Karma. Major Mountain View campus.",
    color: "#236cff",
    url: "https://www.intuit.com",
    employeesNote: "18K employees globally",
  },
  {
    id: "broadcom",
    name: "Broadcom",
    city: "San Jose",
    category: "chip",
    stage: "public",
    tagline: "Semiconductors and enterprise software (VMware). One of SCC's largest private-sector employers.",
    color: "#CC0000",
    url: "https://www.broadcom.com",
    employeesNote: "40K+ employees globally",
  },
  {
    id: "arista",
    name: "Arista Networks",
    city: "Santa Clara",
    category: "network",
    stage: "public",
    tagline: "Cloud networking switches powering hyperscale data centers. Fast-growing alternative to Cisco.",
    color: "#FF6600",
    url: "https://www.arista.com",
    employeesNote: "5K employees globally",
  },
  {
    id: "fortinet",
    name: "Fortinet",
    city: "Sunnyvale",
    category: "security",
    stage: "public",
    tagline: "Network security appliances and SASE platform. Built and run by Ken Xie out of Sunnyvale.",
    color: "#EE3124",
    url: "https://www.fortinet.com",
    employeesNote: "13K employees globally",
  },
  {
    id: "cadence",
    name: "Cadence Design",
    city: "San Jose",
    category: "eda",
    stage: "public",
    tagline: "EDA software for chip design. Every advanced semiconductor is designed with Cadence or Synopsys.",
    color: "#00A896",
    url: "https://www.cadence.com",
    employeesNote: "10K employees globally",
  },
  {
    id: "synopsys",
    name: "Synopsys",
    city: "Sunnyvale",
    category: "eda",
    stage: "public",
    tagline: "The other EDA giant. Merged with Ansys in 2024 to add simulation to chip design software.",
    color: "#5C3693",
    url: "https://www.synopsys.com",
    employeesNote: "20K employees globally",
  },
  {
    id: "pure-storage",
    name: "Pure Storage",
    city: "Mountain View",
    category: "hardware",
    stage: "public",
    tagline: "All-flash storage arrays for enterprise and AI data infrastructure. Growing with AI boom.",
    color: "#FF6900",
    url: "https://www.purestorage.com",
    employeesNote: "5K employees globally",
  },
  {
    id: "nutanix",
    name: "Nutanix",
    city: "San Jose",
    category: "cloud",
    stage: "public",
    tagline: "Hybrid cloud infrastructure software. Hyperconverged infrastructure pioneer finding its post-VMware moment.",
    color: "#024DA1",
    url: "https://www.nutanix.com",
    employeesNote: "7K employees globally",
  },
  {
    id: "intuitive-surgical",
    name: "Intuitive Surgical",
    city: "Sunnyvale",
    category: "medtech",
    stage: "public",
    tagline: "da Vinci robotic surgery systems. Pioneered the surgical robot market and still dominates it.",
    color: "#00A3E0",
    url: "https://www.intuitive.com",
    employeesNote: "12K employees globally",
  },
  {
    id: "cerebras",
    name: "Cerebras Systems",
    city: "Sunnyvale",
    category: "chip",
    stage: "growth",
    tagline: "Wafer-scale AI processor — a single chip the size of a dinner plate. Fastest inference around.",
    color: "#FF4D00",
    url: "https://cerebras.ai",
    employeesNote: "500 employees",
  },
  {
    id: "groq",
    name: "Groq",
    city: "Mountain View",
    category: "chip",
    stage: "growth",
    tagline: "LPU inference chip clocking record token speeds. Built by ex-Google TPU team.",
    color: "#00D4AA",
    url: "https://groq.com",
    employeesNote: "500 employees",
  },
  {
    id: "tenstorrent",
    name: "Tenstorrent",
    city: "San Jose",
    category: "chip",
    stage: "growth",
    tagline: "RISC-V AI chips led by chip legend Jim Keller. Open-architecture play against NVIDIA.",
    color: "#6B21A8",
    url: "https://tenstorrent.com",
    employeesNote: "300 employees",
  },
  {
    id: "d-matrix",
    name: "d-Matrix",
    city: "Santa Clara",
    category: "chip",
    stage: "startup",
    tagline: "In-memory compute chip for AI inference at the data center edge. Well-funded stealth player.",
    color: "#1E3A5F",
    url: "https://www.d-matrix.ai",
    employeesNote: "200 employees",
  },
  {
    id: "ampere-computing",
    name: "Ampere Computing",
    city: "Santa Clara",
    category: "chip",
    stage: "growth",
    tagline: "Cloud-native ARM server CPUs. Oracle-backed, gaining traction in hyperscaler data centers.",
    color: "#0057B8",
    url: "https://amperecomputing.com",
    employeesNote: "600 employees",
  },
  {
    id: "rivos",
    name: "Rivos",
    city: "Mountain View",
    category: "chip",
    stage: "startup",
    tagline: "RISC-V SoC startup founded by ex-Apple chip engineers. Aiming at server and AI workloads.",
    color: "#DC2626",
    url: "https://www.rivos.com",
    employeesNote: "400 employees",
  },
];

// Pulse stats for the header strip
export const TECH_PULSE = [
  {
    value: "130K+",
    label: "Local tech jobs",
    note: "Santa Clara County, est. Q1 2026",
  },
  {
    value: "Google & Apple",
    label: "Largest SCC employers",
    note: "25K local jobs each at Googleplex & Apple Park",
  },
  {
    value: "Intel",
    label: "Most SCC layoffs",
    note: "15K+ cut in 2024; SCC campus significantly smaller",
  },
  {
    value: "AI chips",
    label: "Hot category",
    note: "NVIDIA, AMD, Intel all betting on inference",
  },
];
