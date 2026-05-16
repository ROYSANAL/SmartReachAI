import { NextRequest, NextResponse } from 'next/server';
import { EmailWorkflowProcessor } from '../../../services/emailWorkflowProcessor';

export async function POST(request: NextRequest) {
  console.log('📧 API: Email workflow processing requested');
  
  try {
    const emailProcessor = new EmailWorkflowProcessor();
    
    console.log('🔄 Starting email workflow processing...');
    await emailProcessor.processEmailWorkflow();
    
    console.log('✅ Email workflow processing completed');
    
    return NextResponse.json({
      success: true,
      message: 'Email workflow processing completed successfully',
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    console.error('❌ Email workflow processing failed:', error);
    
    return NextResponse.json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
      timestamp: new Date().toISOString()
    }, { status: 500 });
  }
}

export async function GET(request: NextRequest) {
  return NextResponse.json({
    message: 'Email workflow endpoint - use POST to trigger processing',
    endpoints: {
      'POST /api/email/workflow': 'Process email workflow',
      'GET /api/email/stats': 'Get email statistics'
    }
  });
}