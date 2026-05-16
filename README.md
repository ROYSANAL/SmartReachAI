# SmartReachAI 

**SmartReachAI** is an automated, AI-driven Business Development Representative (BDR) system designed to manage leads, automate outreach, and handle communications seamlessly. Built on top of Next.js, it leverages the power of OpenAI to craft contextual responses, Google Workspace APIs (Gmail Pub/Sub, Google Sheets) to track and manage leads, and automated schedulers to perform outreach across Email and LinkedIn.

## 🌟 Key Features

*   **Automated Email Outreach:** Scheduled email sequences and intelligent follow-ups.
*   **LinkedIn Automation:** Scripts and schedulers specifically built to handle LinkedIn interactions.
*   **Gmail Pub/Sub Integration:** Real-time push notifications for incoming emails to ensure the system reacts instantly.
*   **Google Sheets CRM:** Uses Google Sheets as a lightweight, highly accessible database to store lead information, campaign status, and outreach logs.
*   **AI-Powered Responses:** Integrates with OpenAI's API to analyze incoming messages and draft intelligent, context-aware responses.

## 📂 Project Structure

*   **`/src/app`**: Core Next.js application, including API routes (`/src/app/api`) and external service connectors (`/src/app/services`).
*   **`/src/scheduler`**: Standalone TypeScript schedulers (`main.ts`, `email-scheduler.ts`, `linkedin-scheduler.ts`) responsible for executing periodic background jobs.
*   **`setup-gmail-pubsub.ts`**: A utility script used to configure and initialize Google Cloud Pub/Sub webhooks for your Gmail accounts.

## 🛠️ Prerequisites

Before you begin, ensure you have the following set up:
*   **Node.js** (v18 or higher recommended)
*   **Google Cloud Console Project** with the following APIs enabled:
    *   Gmail API
    *   Google Sheets API
    *   Cloud Pub/Sub API
*   **OpenAI API Key**

## ⚙️ Installation & Setup

1.  **Clone the repository and install dependencies:**
    ```bash
    npm install
    ```

2.  **Environment Variables:**
    Create a `.env` file in the root directory. You will need to provide necessary credentials (refer to the `.env.example` if available, or configure the following essentials):
    ```env
    GOOGLE_CLOUD_PROJECT_ID=your-project-id
    PUBSUB_TOPIC_NAME=your-topic-name # e.g., gmail-email-responses
    OPENAI_API_KEY=your-openai-key
    # Add other necessary Google Service Account / OAuth credentials here
    ```

3.  **Set up Gmail Webhooks:**
    Run the setup script to initialize your Gmail Pub/Sub subscriptions.
    ```bash
    npx tsx setup-gmail-pubsub.ts
    ```

## 🚀 Usage & Commands

The project comes with several npm scripts for running the web server and the background schedulers.

### Web Server (Next.js)

*   **`npm run dev`**: Starts the development server with Turbopack enabled.
*   **`npm run build`**: Builds the Next.js application for production.
*   **`npm run start`**: Starts the production server.

### Automated Schedulers

These commands trigger the background processes that actually perform the outreach. They utilize `tsx` to run TypeScript files directly and load variables from your `.env` file.

*   **`npm run scheduler`**: Runs the main scheduler process (`src/scheduler/main.ts`), managing overall system jobs.
*   **`npm run email`**: Executes the email-specific scheduler (`src/scheduler/email-scheduler.ts`).
*   **`npm run linkedin`**: Executes the LinkedIn-specific scheduler (`src/scheduler/linkedin-scheduler.ts`).

