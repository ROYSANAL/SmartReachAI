// Email sequence templates for the 8-day outreach campaign
// Templates use handlebars-style variables: {{variableName}}

export interface EmailTemplate {
  day: number;
  name: string;
  subject: string;
  content: string;
  variables: string[];
}

export const EMAIL_TEMPLATES: EmailTemplate[] = [
  // Day 1: Cold Email #1 (Opener with Proof)
  {
    day: 1,
    name: "Cold Email #1 (Opener with Proof)",
    subject: "Turning {{companyIndustry}} content into a sales engine",
    content: `Hi {{firstName}},

In {{companyIndustry}}, shoppers expect experiences that are interactive, immediate, and highly relevant. That's exactly what **Live2.ai's AI-Copilot + Shoppable Videos** deliver—empowering enterprise brands to:

• **Boost conversions by 25%–30%**
• **Elevate average order value by 30%**
• **Drive deeper user engagement and loyalty**

Would you be open to a **quick 15-minute chat** next week to explore how this could fuel revenue growth at {{company}}?

Best,
{{salesPersonName}}`,
    variables: ['firstName', 'company', 'companyIndustry', 'salesPersonName']
  },

  // Day 2: Cold Email #2 (Specific Case Study + Social Proof)
  {
    day: 2,
    name: "Cold Email #2 (Specific Case Study + Social Proof)", 
    subject: "How a fashion retailer lifted CTR 35% in weeks",
    content: `Hi {{firstName}},

Quick follow-up—here's some **real-world impact**:

• A mid-sized eCommerce fashion retailer saw **click-through rates jump 35%** using Live2.ai's AI personalization engine
• Another home goods brand boosted their **email campaign interactions and social shares by 50%** within weeks

Curious how similar strategies might work for {{company}}?

Regards,
{{salesPersonName}}`,
    variables: ['firstName', 'company', 'salesPersonName']
  },

  // Day 4: Cold Email #3 (Emotional + Curiosity Play)
  {
    day: 4,
    name: "Cold Email #3 (Emotional + Curiosity Play)",
    subject: "Are shoppers browsing but not buying at {{company}}?",
    content: `Hi {{firstName}},

Many {{companyIndustry}} brands face the same challenge: **visitors engage, but don't convert**.

**Live2.ai's AI-Copilot** guides shoppers with personalized, interactive journeys—resulting in **real uplift in conversions** while creating meaningful emotional connections with consumers.

Would a **15-minute brainstorm** make sense to explore how we could replicate this at {{company}}?

Best,
{{salesPersonName}}`,
    variables: ['firstName', 'company', 'companyIndustry', 'salesPersonName']
  },

  // Day 6: Placeholder (keeping original since no new template provided)
  {
    day: 6,
    name: "Social Proof Follow-up",
    subject: "Quick question about {{company}}'s video strategy",
    content: `Hi {{firstName}},

I wanted to circle back on the **Live2.ai conversation**. I know timing can be everything in {{companyIndustry}}.

If there's a better time to explore how **interactive video** could impact {{company}}'s **conversion rates**, I'm happy to work around your schedule.

Best,
{{salesPersonName}}`,
    variables: ['firstName', 'company', 'companyIndustry', 'salesPersonName']
  },

  // Day 8: Cold Email #4 (Breakup/Last Touch with Optional Video)
  {
    day: 8,
    name: "Cold Email #4 (Breakup/Last Touch)",
    subject: "Should I close the loop, {{firstName}}?",
    content: `Hi {{firstName}},

I haven't heard back, so I'll assume this isn't a priority right now.

Before I close the loop—would you be interested in seeing a **short video demo** of how Live2.ai expertly converts passive views into purchasers? **Real brands are achieving**:

• **35% CTR lift**
• **50% increase in engagement metrics**  
• **25% boost in conversions**

If now isn't ideal, I totally understand—happy to reconnect later this year.

Best,
{{salesPersonName}}`,
    variables: ['firstName', 'salesPersonName']
  }
];

// Template processing utility functions
export function getEmailTemplate(day: number): EmailTemplate | null {
  return EMAIL_TEMPLATES.find(template => template.day === day) || null;
}

export function processTemplate(template: string, variables: Record<string, any>): string {
  let processed = template;
  
  // Replace simple variables like {{firstName}}
  Object.entries(variables).forEach(([key, value]) => {
    const regex = new RegExp(`{{\\s*${key}\\s*}}`, 'gi');
    processed = processed.replace(regex, String(value || ''));
  });

  // Handle conditional blocks {{#if variable}}content{{/if}}
  processed = processed.replace(
    /{{#if\s+(\w+)}}(.*?)(?:{{#else}}(.*?))?{{\/if}}/gis,
    (_match, variable, ifContent, elseContent = '') => {
      return variables[variable] ? ifContent : elseContent;
    }
  );

  // Clean up any remaining empty conditional syntax
  processed = processed.replace(/{{#if\s+\w+}}{{\/if}}/g, '');
  processed = processed.replace(/{{#else}}/g, '');

  // Convert markdown bold (**text**) to HTML strong tags (<strong>text</strong>)
  processed = processed.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');

  return processed.trim();
}

// Default template variables
export function createTemplateVariables(lead: any, salesPersonName: string, salesPersonEmail: string): Record<string, any> {
  return {
    // Lead variables
    firstName: lead.firstName || 'there',
    lastName: lead.lastName || '',
    fullName: lead.fullName || `${lead.firstName} ${lead.lastName}`,
    email: lead.email || '',
    company: lead.company || 'your company',
    jobTitle: lead.jobTitle || '',
    profileHeadline: lead.profileHeadline || '',
    linkedinUrl: lead.linkedinUrl || '',
    companyIndustry: lead.companyIndustry || 'your industry',
    companyWebsite: lead.companyWebsite || '',
    companySize: lead.companySize || '',
    
    // Sales person variables
    salesPersonName: salesPersonName || 'Our team',
    salesPersonEmail: salesPersonEmail || '',
    
    // Live2.ai specific variables
    similarBrand: process.env.SIMILAR_BRAND || 'a leading brand',
    
    // Company variables (from config)
    companyName: process.env.COMPANY_NAME || 'Live2.ai',
    ourCompanyWebsite: process.env.OUR_COMPANY_WEBSITE || 'live2.ai',
    supportEmail: process.env.SUPPORT_EMAIL || 'support@live2.ai',
    
    // Dynamic variables
    currentDate: new Date().toLocaleDateString(),
    currentYear: new Date().getFullYear().toString(),
    
    // Conditional flags for better template logic
    hasJobTitle: Boolean(lead.jobTitle),
    hasCompany: Boolean(lead.company),
    hasLinkedIn: Boolean(lead.linkedinUrl),
    hasProfileHeadline: Boolean(lead.profileHeadline),
    hasCompanyIndustry: Boolean(lead.companyIndustry)
  };
}