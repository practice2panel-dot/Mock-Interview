import React, { useState, useEffect, useRef } from 'react';
import { 
  ArrowLeft, 
  Mic, 
  MicOff,
  Loader2,
  Trophy,
  User,
  Brain,
  BookOpen,
  Target,
  CheckCircle,
  X,
  Phone,
  PhoneOff,
  Clock,
  Play
} from 'lucide-react';
import VapiSDK from '@vapi-ai/web';
import { API_BASE_URL } from '../config';
import { jobRoles } from '../jobRolesConfig';
import './MockInterview.css';

const MockInterview = () => {
  // Form state
  const [showForm, setShowForm] = useState(true);
  const [candidateName, setCandidateName] = useState('');
  const [selectedRole, setSelectedRole] = useState('');
  const [selectedInterviewType, setSelectedInterviewType] = useState('');
  const [currentStep, setCurrentStep] = useState('name'); // 'name' | 'role' | 'type'
  const [roleSearchTerm, setRoleSearchTerm] = useState('');
  const [showRoleSuggestions, setShowRoleSuggestions] = useState(false);
  const [interviewTypeSearchTerm, setInterviewTypeSearchTerm] = useState('');
  const [showInterviewTypeSuggestions, setShowInterviewTypeSuggestions] = useState(true);
  
  // Interview state
  const [isInterviewActive, setIsInterviewActive] = useState(false);
  const [isCallActive, setIsCallActive] = useState(false);
  const [conversationHistory, setConversationHistory] = useState([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');
  const [interviewTimer, setInterviewTimer] = useState(0);
  const [isMuted, setIsMuted] = useState(false);
  
  // VAPI state
  const [callStatus, setCallStatus] = useState('idle');
  const [activeSpeaker, setActiveSpeaker] = useState(null);
  const [currentRecruiterText, setCurrentRecruiterText] = useState('');
  const [currentCandidateText, setCurrentCandidateText] = useState('');
  const [, setQuestionsAskedCount] = useState(0);
  const vapiRef = useRef(null);
  const vapiListenersRef = useRef([]);
  const speakerTimeoutRef = useRef({ recruiter: null, candidate: null });
  const conversationHistoryRef = useRef([]);
  const transcriptAccumulatorRef = useRef({ assistant: '', user: '' });
  const lastStoredMessageRef = useRef({ assistant: '', user: '' });
  
  // Feedback state
  const [showFeedback, setShowFeedback] = useState(false);
  const [feedbackData, setFeedbackData] = useState(null);
  const [isGeneratingFeedback, setIsGeneratingFeedback] = useState(false);
  const isRestoringRef = useRef(true);
  
  useEffect(() => {
    if (showFeedback) {
      setShowForm(false);
    }
  }, [showFeedback]);

  useEffect(() => {
    isRestoringRef.current = false;
  }, []);

  const clearVapiListeners = () => {
    if (vapiRef.current?.off) {
      vapiListenersRef.current.forEach(({ event, handler }) => {
        vapiRef.current.off(event, handler);
      });
    }
    vapiListenersRef.current = [];
  };

  const clearSpeakerTimeouts = () => {
    Object.values(speakerTimeoutRef.current).forEach((timeoutId) => {
      if (timeoutId) clearTimeout(timeoutId);
    });
    speakerTimeoutRef.current = { recruiter: null, candidate: null };
  };

  const setActiveSpeakerWithTimeout = (role, duration = 1200) => {
    if (!role) return;
    setActiveSpeaker(role);
    if (speakerTimeoutRef.current[role]) {
      clearTimeout(speakerTimeoutRef.current[role]);
    }
    speakerTimeoutRef.current[role] = setTimeout(() => {
      setActiveSpeaker((prev) => (prev === role ? null : prev));
    }, duration);
  };

  const normalizeSpeakerRole = (data) => {
    const raw = (
      data?.role ||
      data?.type ||
      data?.speaker ||
      data?.source ||
      ''
    )
      .toString()
      .toLowerCase();

    const roleMatchers = [
      { role: 'recruiter', terms: ['assistant', 'agent', 'ai'] },
      { role: 'candidate', terms: ['user', 'human', 'candidate'] }
    ];

    const match = roleMatchers.find(({ terms }) =>
      terms.some((term) => raw.includes(term))
    );

    return match ? match.role : null;
  };

  const roleToSpeaker = {
    assistant: 'recruiter',
    user: 'candidate'
  };

  const speakerToRoleKey = {
    recruiter: 'assistant',
    candidate: 'user'
  };

  const roleTextSetters = {
    assistant: setCurrentRecruiterText,
    user: setCurrentCandidateText
  };

  const speakerTextClearers = {
    recruiter: () => setCurrentRecruiterText(''),
    candidate: () => setCurrentCandidateText('')
  };

  // -------- Helper functions (to avoid big if / else chains) --------

  const getMicErrorMessage = (micError) => {
    const name = micError?.name;

    const byName = {
      NotAllowedError: 'Microphone permission denied. Please allow microphone access in your browser settings.',
      PermissionDeniedError: 'Microphone permission denied. Please allow microphone access in your browser settings.',
      NotFoundError: 'No microphone found. Please connect a microphone and try again.',
      DevicesNotFoundError: 'No microphone found. Please connect a microphone and try again.'
    };

    if (byName[name]) {
      return byName[name];
    }

    const base = micError?.message || 'Unknown error';
    return `Microphone access error: ${base}`;
  };

  const getVapiStatusCode = (error) =>
    error?.status ||
    error?.statusCode ||
    error?.response?.status ||
    (typeof error?.error === 'object' && error.error?.statusCode);

  const getBaseVapiMessage = (error) => {
    const nested = error?.error;
    if (typeof nested === 'object' && nested?.message) return nested.message;
    if (error?.message) return error.message;
    if (error?.response?.data?.message) return error.response.data.message;
    if (error?.response?.statusText) return error.response.statusText;
    if (typeof error === 'string') return error;
    if (error?.toString) return error.toString();
    return 'Unknown error';
  };

  const getVapiErrorInfo = (error) => {
    const statusCode = getVapiStatusCode(error);
    const baseMessage = getBaseVapiMessage(error);

    const byStatus = {
      401:
        'VAPI rejected the browser key (401). Use the Public API key in frontend/.env as REACT_APP_VAPI_PUBLIC_KEY — not the Private key. The Private key belongs only in Backend/.env as VAPI_PRIVATE_KEY. Copy both from https://dashboard.vapi.ai → API Keys.',
      403: 'VAPI API key does not have permission. Please check your VAPI account permissions.',
      400: (msg) => `VAPI request error: ${msg}. Please check your assistant configuration.`
    };

    const specific = byStatus[statusCode];

    if (!specific) {
      return { statusCode, message: baseMessage };
    }

    if (typeof specific === 'function') {
      return { statusCode, message: specific(baseMessage) };
    }

    return { statusCode, message: specific };
  };

  // Interview types
  const interviewTypes = [
    { value: 'technical', label: 'Technical Interview', icon: <Brain size={20} /> },
    { value: 'conceptual', label: 'Conceptual Interview', icon: <BookOpen size={20} /> },
    { value: 'behavioral', label: 'Behavioral Interview', icon: <User size={20} /> }
  ];


  // Fetch questions for all skills. Returns questions in the same tick so callers can
  // build prompts without relying on React state that would still be stale until re-render.
  const fetchQuestions = async () => {
    try {
      setIsLoading(true);
      setError('');

      const roleConfig = jobRoles[selectedRole];
      const skillsForRole = roleConfig?.skills ?? [];

      const response = await fetch(`${API_BASE_URL}/api/mock-interview/questions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          job_role: selectedRole,
          interview_type: selectedInterviewType,
          // Same skill labels as Skill Prep → same DB tables ({type}_python, etc.)
          skills: skillsForRole
        })
      });

      let data = {};
      try {
        data = await response.json();
      } catch (_) {
        /* non-JSON response */
      }

      if (!response.ok) {
        setError(data.message || `Failed to fetch questions (${response.status})`);
        return { ok: false, questions: [] };
      }

      if (data.success && Array.isArray(data.questions) && data.questions.length > 0) {
        return { ok: true, questions: data.questions };
      }

      setError(data.message || 'No questions available for this role and interview type.');
      return { ok: false, questions: [] };
    } catch (error) {
      console.error('Error fetching questions:', error);
      setError('Failed to load questions. Please try again.');
      return { ok: false, questions: [] };
    } finally {
      setIsLoading(false);
    }
  };

  // Start VAPI call using Web SDK (no phone number required)
  const startInterview = async () => {
    if (!candidateName.trim() || !selectedRole || !selectedInterviewType) {
      setError('Please fill in all fields');
      return;
    }


    // Fetch questions first (use returned array — state is still stale until next render)
    const { ok: questionsOk, questions: questionsForPrompt } = await fetchQuestions();
    if (!questionsOk || !questionsForPrompt?.length) {
      return;
    }

    try {
      setIsLoading(true);
      setError('');

      // Build system message for VAPI
      const skills = jobRoles[selectedRole].skills.join(', ');
      
      // Map interview types to their descriptions
      const interviewTypeDescriptions = {
        'technical': 'technical questions focusing on practical skills, tools, and implementation',
        'conceptual': 'conceptual questions focusing on understanding, theory, and deep knowledge',
        'behavioral': 'behavioral questions focusing on past experiences, situations, and soft skills',
        'problem solving': 'problem-solving questions focusing on analytical thinking and solution approaches'
      };
      
      const interviewTypeDesc = interviewTypeDescriptions[selectedInterviewType.toLowerCase()] || `${selectedInterviewType} questions`;
      
      const systemMessage = `You are a professional recruiter conducting a ${selectedInterviewType} interview for the position of ${selectedRole}. 
      
The candidate's name is ${candidateName}.

You are conducting a ${selectedInterviewType.toUpperCase()} interview for a ${selectedRole} position. The key skills for this role are: ${skills}.

CRITICAL: This is a ${selectedInterviewType.toUpperCase()} interview. You MUST ask ${interviewTypeDesc} from the database. 
- If this is a TECHNICAL interview, ask technical questions only
- If this is a CONCEPTUAL interview, ask conceptual/theoretical questions only  
- If this is a BEHAVIORAL interview, ask behavioral/situational questions only

CRITICAL INTERVIEW FLOW - FOLLOW THIS EXACTLY:
1. Start with a VARIED greeting (use a different greeting each time, examples below):
   - "Good morning ${candidateName}! Thank you for joining us today. I'm looking forward to our conversation."
   - "Hello ${candidateName}, welcome! I appreciate you taking the time to speak with us today."
   - "Hi ${candidateName}, thanks for being here. I'm excited to learn more about you today."
   - "Good to meet you, ${candidateName}! Thank you for your interest in this position."
   - "Hello ${candidateName}, thank you for your time today. Let's get started!"
   (Choose a different greeting each time - don't repeat the same one)

2. IMMEDIATELY after the greeting, ask ONLY the FIRST question: "Could you please introduce yourself and tell me about your background?"
3. STOP and WAIT for the candidate's complete response. DO NOT ask another question until they finish answering.
4. After they finish introducing themselves, ask 1-2 follow-up questions based on what they said. Wait for each answer before asking the next follow-up.
5. Once you've finished the follow-up questionsabout their introduction, you MUST move to the ACTUAL ${selectedInterviewType.toUpperCase()} QUESTIONS from the database question bank provided below.
6. IMPORTANT: You have ${questionsForPrompt.length} ${selectedInterviewType} questions from the database. You MUST ask these actual ${selectedInterviewType} questions from the list.
7. For EACH main question from the database (ask 3 questions per skill total):
   - Ask ONLY ONE ${selectedInterviewType} question at a time (exactly as it appears in the question bank or rephrase it naturally while keeping it a ${selectedInterviewType} question)
   - STOP immediately - do NOT add any other questions or statements
   - WAIT for the candidate's COMPLETE answer - do NOT interrupt or ask another question
   - After they COMPLETE their answer, ask ONE follow-up question based on their answer
   - WAIT for that follow-up answer completely
   - Then ask ONE more follow-up question ONLY if needed (maximum 3 follow-ups total per main question)
   - WAIT for that answer completely
   - Only then move to the next main question from the database
8. Pattern: ONE Database ${selectedInterviewType} Question → WAIT for Complete Answer → ONE Follow-up → WAIT → ONE Follow-up (optional, max 3 total) → WAIT → Next ONE Database ${selectedInterviewType} Question
9. IMPORTANT - INTERVIEW DURATION AND ENDING: 
   - The interview should take about 15 minutes total
   - Keep track of time and questions asked
   - After finishing the last question around the 15-minute mark, you MUST end the interview
   - When you decide to end, you MUST conclude with a proper closing message like:
     "Thank you ${candidateName} for your time today. I've asked you about ${selectedInterviewType} topics and I appreciate your thoughtful responses. We'll be in touch soon with feedback. Have a great day!"
   - After saying the closing message, the interview will end naturally
   - DO NOT abruptly stop - always end with a proper closing message
10. Make sure to ask ${selectedInterviewType} questions from different skill areas in the question bank (3 questions per skill).
11. You have control over when to end the interview - use your judgment to finish after the last question around the 15-minute mark.

CRITICAL RULES - FOLLOW STRICTLY:
- You MUST ask the actual questions from the database question bank provided
- Do NOT only ask follow-up questions - you must ask the main questions from the database first
- After each database question, ask 1-3 follow-up questions (maximum 3 follow-ups per main question)
- NEVER skip the database questions - they are mandatory
- NEVER EVER ask multiple questions at once - THIS IS STRICTLY FORBIDDEN
- ALWAYS ask ONLY ONE question at a time
- ALWAYS wait for the candidate's COMPLETE response before asking the next question
- Ask ONE main question → WAIT for complete answer → Then ask ONE follow-up → WAIT → ONE more follow-up (optional, max 3) → WAIT → Then next main question
- Do NOT rush - give the candidate time to think and respond
- Do NOT combine questions like "What is X and how does Y work?" - Ask them separately
- Do NOT ask follow-up questions in the same message as the main question
- Pattern: ONE main question → Wait for complete answer → ONE follow-up → Wait → ONE more follow-up (optional, max 3) → Wait → Next ONE main question

CONVERSATION STYLE:
- Be conversational, professional, and encouraging
- Make the candidate feel comfortable while still assessing their knowledge
- Ask the actual questions from the database, then ask ONLY ONE relevant follow-up question after each main question answer
- Make the conversation feel natural and interactive, not like reading from a script
- Follow-up questions are important, but the database questions are MANDATORY and must be asked first
- PATIENCE is key - wait for complete answers before proceeding
- NEVER ask multiple questions in one message - always one at a time

EXAMPLES OF WHAT NOT TO DO:
❌ "What is machine learning? And can you explain deep learning too?"
❌ "Tell me about your experience with Python. Also, how do you handle errors?"
❌ "What challenges did you face? How did you solve them? What was the outcome?"

EXAMPLES OF WHAT TO DO:
✅ "What is machine learning?" → Wait for complete answer → "Can you give me a specific example?" → Wait for complete answer → Next main question
✅ "Tell me about your experience with Python." → Wait for complete answer → "Can you describe a project where you used Python?" → Wait for complete answer → Next main question`;

      // Build assistant message with questions
      const questionsText = questionsForPrompt.map((q, idx) => 
        `${idx + 1}. [${q.skill}] ${q.question}`
      ).join('\n');

      const assistantMessage = `IMPORTANT: You have a list of ACTUAL ${selectedInterviewType.toUpperCase()} QUESTIONS from the database below. You MUST ask 3 questions per skill during this ${selectedInterviewType} interview.

CRITICAL: This is a ${selectedInterviewType.toUpperCase()} interview. You MUST only ask ${selectedInterviewType} questions from the database below.
- If this is TECHNICAL: ask only technical questions
- If this is CONCEPTUAL: ask only conceptual/theoretical questions
- If this is BEHAVIORAL: ask only behavioral/situational questions  
- If this is PROBLEM SOLVING: ask only problem-solving/analytical questions

${selectedInterviewType.toUpperCase()} DATABASE QUESTIONS (ASK 3 PER SKILL):
${questionsText}

CRITICAL INSTRUCTIONS - READ CAREFULLY:
1. After the greeting and introduction follow-ups, you MUST start asking the ACTUAL ${selectedInterviewType.toUpperCase()} QUESTIONS from the database list above.
2. You MUST ask 3 questions per skill from the list above. Randomize question order between skills.
3. For EACH ${selectedInterviewType} question from the database:
   - Ask ONLY ONE ${selectedInterviewType} question (you can rephrase it naturally but keep it as a ${selectedInterviewType} question)
   - STOP immediately after asking the question
   - WAIT for the candidate's COMPLETE response - do NOT ask anything else until they finish
   - After they COMPLETE their answer, ask ONE follow-up question based on their answer
   - WAIT for that follow-up answer completely
   - Then ask ONE more follow-up question ONLY if needed (maximum 2 follow-ups total per main question)
   - WAIT for that answer completely
   - Only then move to the next main question
4. Pattern: ONE Database ${selectedInterviewType} Question → WAIT for Complete Answer → ONE Follow-up → WAIT → ONE Follow-up (optional, max 2 total) → WAIT → Next ONE Database ${selectedInterviewType} Question
5. IMPORTANT - INTERVIEW DURATION AND ENDING:
   - The interview should take about 15 minutes total
   - Keep track of time and questions asked
   - After finishing the last question around the 15-minute mark, you MUST end the interview
   - When you decide it's time to end, you MUST conclude with a proper, professional closing message
   - Your closing message MUST be something like: "Thank you ${candidateName} for your time today. I've enjoyed our conversation and learned about your ${selectedInterviewType} experience. We'll be in touch soon with feedback. Have a great day!"
   - After delivering the closing message, the interview will end naturally
   - DO NOT end abruptly - always provide a proper closing
6. NEVER skip the database ${selectedInterviewType} questions - they are mandatory
7. NEVER ask only follow-up questions without asking the main ${selectedInterviewType} database questions first
8. NEVER ask questions from other interview types - only ask ${selectedInterviewType} questions
9. NEVER ask multiple questions in one message - ALWAYS one question per message
10. Make sure to ask ${selectedInterviewType} questions from different skill areas (3 questions per skill)
11. Follow-up questions should relate to ${selectedInterviewType} aspects and be asked ONE AT A TIME (maximum 2-3 follow-ups per main question):
   - Probe deeper: "Can you give me a specific example?" → Wait for answer
   - Ask for details: "How did you handle that situation?" → Wait for answer
   - Clarify understanding: "What challenges did you face?" → Wait for answer
   - Explore further: "Tell me more about that approach" → Wait for answer
   - Remember: Maximum 2 follow-up questions per main question, then move to the next main question
12. Remember: ONE question per message. Wait for complete answer. Then next question. Ask 3 per skill, keep total interview about 15 minutes, then end with a proper closing message.`;

      // Get assistant configuration from backend
      setCallStatus('connecting');
      
      const configResponse = await fetch(`${API_BASE_URL}/api/mock-interview/get-assistant-config`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          candidate_name: candidateName,
          job_role: selectedRole,
          interview_type: selectedInterviewType,
          questions: questionsForPrompt,
          system_message: systemMessage,
          assistant_message: assistantMessage
        })
      });

      const configData = await configResponse.json();
      
      if (!configResponse.ok || !configData.success) {
        // Check for credit errors
        if (configData.credit_error || configResponse.status === 402) {
          throw new Error(
            configData.message || 
            'VAPI credits may be exhausted. Please check your VAPI account balance at https://dashboard.vapi.ai and add credits if needed.'
          );
        }
        throw new Error(configData.message || 'Failed to get assistant configuration');
      }
      
      // Show warning if assistant creation failed but using fallback
      if (configData.warning) {
        console.warn('Assistant config warning:', configData.warning);
        // Check if it's a credit-related warning
        if (configData.warning.toLowerCase().includes('credit') || 
            configData.warning.toLowerCase().includes('balance')) {
          setError('⚠️ VAPI Credits Warning: ' + configData.warning + ' Please check your account balance.');
        }
      }

      let vapiPublicKey = (process.env.REACT_APP_VAPI_PUBLIC_KEY || '')
        .trim()
        .replace(/^["']|["']$/g, '');
      
      if (!vapiPublicKey) {
        throw new Error('VAPI Public Key not configured. Please add REACT_APP_VAPI_PUBLIC_KEY to your frontend/.env file.');
      }
      
      if (vapiPublicKey.length < 20) {
        console.warn('VAPI Public Key seems too short. Please verify it\'s correct.');
      }

      // Request microphone permissions
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        stream.getTracks().forEach(track => track.stop());
      } catch (micError) {
        throw new Error(getMicErrorMessage(micError));
      }

      const Vapi = VapiSDK.default || VapiSDK;
      
      if (typeof Vapi !== 'function') {
        throw new Error('VAPI SDK not loaded correctly. Please restart your development server.');
      }
      
      let vapi;
      try {
        vapi = new Vapi(vapiPublicKey);
      } catch (initError) {
        try {
          vapi = new Vapi({
            apiKey: vapiPublicKey,
            serverUrl: 'https://api.vapi.ai'
          });
        } catch (altError) {
          throw new Error(`Failed to initialize VAPI SDK: ${initError.message || altError.message}`);
        }
      }
      
      if (!vapi) {
        throw new Error('Failed to initialize VAPI SDK. Please check your API key.');
      }
      
      const addVapiListener = (event, handler) => {
        vapi.on(event, handler);
        vapiListenersRef.current.push({ event, handler });
      };

      clearVapiListeners();

      // Assign before start() so the error handler can stop the client if the web call fails
      vapiRef.current = vapi;

      addVapiListener('error', (error) => {
        console.error('VAPI error event:', error);

        const { statusCode, message } = getVapiErrorInfo(error);
        const msgLower = (message || '').toLowerCase();
        const isBilling =
          msgLower.includes('wallet') ||
          msgLower.includes('balance') ||
          msgLower.includes('credit') ||
          msgLower.includes('purchase') ||
          msgLower.includes('payment') ||
          msgLower.includes('plan');

        const displayMsg = isBilling
          ? `${message} Add credits or upgrade your plan at https://dashboard.vapi.ai — voice calls cannot start until your VAPI balance is positive.`
          : `VAPI error (${statusCode || 'Unknown'}): ${message}`;

        setError(displayMsg);
        setIsLoading(false);
        setCallStatus('idle');
        setIsCallActive(false);
        setIsInterviewActive(false);
        setShowForm(true);

        try {
          vapiRef.current?.stop?.();
        } catch (_) {
          /* ignore */
        }
        clearVapiListeners();
        vapiRef.current = null;
      });
      
      addVapiListener('call-start', (callData) => {
        const callId = callData?.id || callData?.callId || callData?.call?.id;
        if (callId) console.log('Call ID received:', callId);
      });
      
      try {
        let callConfig = configData.assistant 
          ? { ...configData.assistant }
          : configData.assistantId 
            ? { assistantId: configData.assistantId }
            : null;
        
        if (!callConfig) {
          throw new Error('No assistant configuration provided');
        }
        
        if (!callConfig.voice && configData.assistant?.voice) {
          callConfig.voice = configData.assistant.voice;
        }
        
        // Log config for debugging
        console.log('VAPI Call Config:', JSON.stringify(callConfig, null, 2));
        
        try {
          await vapi.start(callConfig);
        } catch (startError) {
          console.error('VAPI start error details:', startError);
          console.error('Error response:', startError?.response);
          console.error('Error message:', startError?.message);
          
          const status = startError?.response?.status || startError?.status || startError?.error?.status || startError?.statusCode;
          const errorMessage =
            startError?.response?.data?.message ||
            (typeof startError?.error === 'object' && startError.error?.message) ||
            startError?.message ||
            JSON.stringify(startError);
          
          // Try fallback if we have assistantId and full assistant config
          if (status === 400 && callConfig.assistantId && configData.assistant) {
            console.log('Trying fallback: using full assistant config instead of assistantId');
            callConfig = { ...configData.assistant };
            try {
              await vapi.start(callConfig);
            } catch (fallbackError) {
              console.error('Fallback also failed:', fallbackError);
              throw new Error(`VAPI configuration error (400): ${errorMessage}. Please check your assistant configuration.`);
            }
          } else if (status === 401) {
            throw new Error(
              'VAPI web call unauthorized (401). Put the Public API key in frontend/.env (REACT_APP_VAPI_PUBLIC_KEY). ' +
                'Put the Private API key in Backend/.env (VAPI_PRIVATE_KEY). Do not swap them. Restart both servers after editing .env.'
            );
          } else if (status === 400) {
            // Check if it's a credit-related error
            const errorLower = errorMessage.toLowerCase();
            if (errorLower.includes('credit') || errorLower.includes('balance') || 
                errorLower.includes('insufficient') || errorLower.includes('payment')) {
              throw new Error(
                `VAPI Credits Issue (400): ${errorMessage}. ` +
                `Please check your VAPI account balance at https://dashboard.vapi.ai and add credits if needed.`
              );
            }
            throw new Error(`VAPI configuration error (400): ${errorMessage}. The assistant configuration may be invalid. Please check the backend logs.`);
          } else if (status === 402) {
            throw new Error(
              `VAPI Payment Required (402): ${errorMessage}. ` +
              `Your VAPI account may have insufficient credits. Please check your balance at https://dashboard.vapi.ai`
            );
          } else {
            throw new Error(`VAPI error (${status || 'Unknown'}): ${errorMessage}`);
          }
        }
        
        setCallStatus('connected');
        setIsCallActive(true);
        setIsInterviewActive(true);
        setIsLoading(false);
        setShowForm(false);
        
        setConversationHistory([]);
        conversationHistoryRef.current = [];
        transcriptAccumulatorRef.current = { assistant: '', user: '' };
        lastStoredMessageRef.current = { assistant: '', user: '' };
        
        // Helper function to store message in conversation history
        const storeMessage = (role, content) => {
          if (!content || !content.trim() || content.trim().length < 3) {
            return; // Skip very short messages
          }
          
          const trimmedContent = content.trim();
          
          // Avoid storing duplicate messages
          if (lastStoredMessageRef.current[role] === trimmedContent) {
            return;
          }
          
          setConversationHistory(prev => {
            // Check if this message is already in history
            const isDuplicate = prev.some(
              msg => msg.role === role && msg.content === trimmedContent
            );
            
            if (isDuplicate) {
              return prev;
            }
            
            const newMessage = {
              role: role,
              content: trimmedContent
            };
            
            const newHistory = [...prev, newMessage];
            conversationHistoryRef.current = newHistory;
            lastStoredMessageRef.current[role] = trimmedContent;
            
            console.log(`✅ Stored ${role} message. Total messages: ${newHistory.length}`, {
              messageContent: trimmedContent.substring(0, 100),
              totalHistoryLength: newHistory.length
            });
            
            // Track questions for display
            if (role === 'assistant' && trimmedContent.length > 20) {
              const isMainQuestion = (
                trimmedContent.includes('?') && trimmedContent.length > 30 &&
                (trimmedContent.toLowerCase().includes('what') || 
                 trimmedContent.toLowerCase().includes('how') || 
                 trimmedContent.toLowerCase().includes('why') ||
                 trimmedContent.toLowerCase().includes('explain') ||
                 trimmedContent.toLowerCase().includes('describe') ||
                 trimmedContent.toLowerCase().includes('tell me about') ||
                 trimmedContent.toLowerCase().includes('can you'))
              );
              
              if (isMainQuestion) {
                setQuestionsAskedCount(prev => prev + 1);
              }
            }
            
            return newHistory;
          });
        };
        
        // Handle message events (final messages from VAPI)
        addVapiListener('message', (message) => {
          console.log('📨 VAPI message received:', {
            role: message.role,
            hasContent: !!(message.content || message.text || message.transcript),
            contentLength: (message.content || message.text || message.transcript || '').length,
            contentPreview: (message.content || message.text || message.transcript || '').substring(0, 50),
            fullMessage: message
          });
          
          const normalized = roleToSpeaker[message.role];
          const content = message.content || message.text || message.transcript || '';

          if (normalized && content && content.trim().length > 0) {
            setActiveSpeakerWithTimeout(normalized, 1500);
            storeMessage(message.role, content);
          }
        });
        
        // Handle transcript events (real-time transcription)
        const handleTranscript = (data) => {
          const text = data.text || data.transcript || data.content || '';
          const role = data.role || data.type;
          const transcriptType = data.transcriptType || 'partial';
          
          console.log('📝 Transcript event:', {
            role,
            transcriptType,
            textLength: text?.length || 0,
            textPreview: text?.substring(0, 50) || '',
            fullData: data
          });
          
          // Update display text for real-time feedback
          const setText = roleTextSetters[role];
          if (setText) setText(text);

          // Accumulate transcripts for assistant and user
          const normalized = roleToSpeaker[role];
          if (normalized && text && text.trim().length > 0) {
            setActiveSpeakerWithTimeout(normalized);

            // Always update accumulator with latest transcript
            transcriptAccumulatorRef.current[role] = text.trim();
            
            // If this is a final transcript, store it immediately
            if (transcriptType === 'final' || transcriptType === 'complete') {
              console.log(`✅ Final transcript for ${role}, storing:`, text.substring(0, 50));
              storeMessage(role, text.trim());
              transcriptAccumulatorRef.current[role] = '';
            }
          }
        };
        
        // Store accumulated transcript when speaking stops
        const handleSpeakingStopWithStorage = (data) => {
          const role = normalizeSpeakerRole(data);
          
          if (!role) return;

          setActiveSpeaker((prev) => (prev === role ? null : prev));
          speakerTextClearers[role]?.();

          // Store accumulated transcript if it exists
          const roleKey = speakerToRoleKey[role];
          const accumulated = transcriptAccumulatorRef.current[roleKey];
          if (accumulated && accumulated.trim().length > 3) {
            console.log(`💾 Storing ${roleKey} transcript on speaking stop:`, accumulated.substring(0, 50));
            storeMessage(roleKey, accumulated);
            transcriptAccumulatorRef.current[roleKey] = '';
          }
        };
        
        addVapiListener('transcript', handleTranscript);
        addVapiListener('transcription', handleTranscript);
        addVapiListener('partial-message', handleTranscript);
        
        // Also listen for function-call events which might contain messages
        addVapiListener('function-call', (data) => {
          console.log('🔧 Function call event:', data);
        });
        
        // Listen for status updates
        addVapiListener('status-update', (data) => {
          console.log('📊 Status update:', data);
        });
        
        // Listen for VAPI speaking events (preferred)
        const handleAssistantSpeechStart = () => setActiveSpeakerWithTimeout('recruiter');
        const handleAssistantSpeechEnd = () =>
          setActiveSpeaker((prev) => (prev === 'recruiter' ? null : prev));
        const handleUserSpeechStart = () => setActiveSpeakerWithTimeout('candidate');
        const handleUserSpeechEnd = () =>
          setActiveSpeaker((prev) => (prev === 'candidate' ? null : prev));

        addVapiListener('assistant.speech.start', handleAssistantSpeechStart);
        addVapiListener('assistant.speech.end', handleAssistantSpeechEnd);
        addVapiListener('user.speech.start', handleUserSpeechStart);
        addVapiListener('user.speech.end', handleUserSpeechEnd);

        // Fallback: speaking events (role-based)
        const handleSpeakingStart = (data) => {
          const role = normalizeSpeakerRole(data);
          if (role) {
            setActiveSpeakerWithTimeout(role);
          }
        };

        const handleSpeakingEnd = (data) => {
          const role = normalizeSpeakerRole(data);
          if (role) setActiveSpeaker((prev) => (prev === role ? null : prev));
        };

        addVapiListener('speaking-start', handleSpeakingStart);
        addVapiListener('speaking-stop', handleSpeakingStopWithStorage);
        addVapiListener('speech-start', handleSpeakingStart);
        addVapiListener('speech-end', handleSpeakingEnd);
        addVapiListener('assistant-started-speaking', () => setActiveSpeakerWithTimeout('recruiter'));
        addVapiListener('assistant-stopped-speaking', () =>
          setActiveSpeaker((prev) => (prev === 'recruiter' ? null : prev))
        );
        addVapiListener('user-started-speaking', () => setActiveSpeakerWithTimeout('candidate'));
        addVapiListener('user-stopped-speaking', () =>
          setActiveSpeaker((prev) => (prev === 'candidate' ? null : prev))
        );
        
        addVapiListener('call-end', async () => {
          console.log('📞 Call ended event received');
          setCallStatus('ended');
          setIsCallActive(false);
          setIsInterviewActive(false);
          setActiveSpeaker(null);
          clearSpeakerTimeouts();
          
          // Store any remaining accumulated transcripts
          const remainingTranscripts = transcriptAccumulatorRef.current;
          if (remainingTranscripts.assistant && remainingTranscripts.assistant.trim().length > 3) {
            console.log('💾 Storing remaining assistant transcript:', remainingTranscripts.assistant.substring(0, 50));
            storeMessage('assistant', remainingTranscripts.assistant);
          }
          if (remainingTranscripts.user && remainingTranscripts.user.trim().length > 3) {
            console.log('💾 Storing remaining user transcript:', remainingTranscripts.user.substring(0, 50));
            storeMessage('user', remainingTranscripts.user);
          }
          
          // Wait a bit to ensure all messages are collected, then use ref for latest history
          setTimeout(async () => {
            const finalHistory = conversationHistoryRef.current;
            const stateHistory = conversationHistory;
            
            console.log('📊 Final conversation history check:', {
              refLength: finalHistory?.length || 0,
              stateLength: stateHistory?.length || 0,
              refMessages: finalHistory?.map(m => ({
                role: m.role,
                contentLength: m.content?.length || 0,
                preview: m.content?.substring(0, 50)
              })),
              stateMessages: stateHistory?.map(m => ({
                role: m.role,
                contentLength: m.content?.length || 0,
                preview: m.content?.substring(0, 50)
              })),
              accumulatedTranscripts: transcriptAccumulatorRef.current
            });
            
            // Use ref value which has the latest conversation
            if (finalHistory && finalHistory.length > 0) {
              console.log('✅ Using ref history for feedback generation');
              await generateFeedback(finalHistory);
            } else if (stateHistory && stateHistory.length > 0) {
              console.log('⚠️ Ref empty, using state history for feedback generation');
              await generateFeedback(stateHistory);
            } else {
              console.error('❌ No conversation history found in either ref or state!');
              console.error('Debug info:', {
                refHistory: finalHistory,
                stateHistory: stateHistory,
                accumulated: transcriptAccumulatorRef.current
              });
              setError('No conversation history was captured. Please ensure you participated in the interview and spoke during the call.');
              setIsGeneratingFeedback(false);
            }
          }, 3000); // Increased delay to ensure all messages are captured

          clearVapiListeners();
        });
        
      } catch (startError) {
        console.error('Error starting VAPI call:', startError);
        try {
          vapiRef.current?.stop?.();
        } catch (_) {
          /* ignore */
        }
        clearVapiListeners();
        vapiRef.current = null;
        throw new Error(`Failed to start call: ${startError.message || 'Unknown error'}`);
      }
      
    } catch (error) {
      console.error('Error starting interview:', error);
      setError(`Failed to start interview: ${error.message || 'Unknown error'}`);
      setIsLoading(false);
      setCallStatus('idle');
      setIsCallActive(false);
      setIsInterviewActive(false);
      setShowForm(true);
    }
  };

  // Generate feedback from conversation history
  const generateFeedback = async (historyToUse = null) => {
    // Use provided history or fallback to state/ref
    const history = historyToUse || conversationHistoryRef.current || conversationHistory;
    
    console.log('Generating feedback...', {
      conversationHistoryLength: history?.length,
      selectedRole,
      selectedInterviewType,
      candidateName,
      usingRef: !!historyToUse || !!conversationHistoryRef.current
    });
    
    if (!history || history.length === 0) {
      console.error('No conversation history found');
      setError('No conversation history found. Cannot generate feedback.');
      setIsGeneratingFeedback(false);
      return;
    }
    
    // Filter and clean messages - remove empty ones, keep only valid structure
    const cleanedHistory = history.filter(
      msg => msg && 
      (msg.role === 'assistant' || msg.role === 'user') &&
      msg.content && 
      typeof msg.content === 'string' &&
      msg.content.trim().length > 0
    );
    
    // Check if we have meaningful conversation (at least some content)
    const meaningfulMessages = cleanedHistory.filter(
      msg => msg.content.trim().length > 5
    );
    const userMessages = meaningfulMessages.filter(
      msg => msg.role === 'user' && msg.content.trim().length > 10
    );
    const assistantMessages = meaningfulMessages.filter(
      msg => msg.role === 'assistant' && msg.content.trim().length > 10
    );
    
    // Debug: Show sample messages
    const sampleUser = userMessages.slice(0, 2);
    const sampleAssistant = assistantMessages.slice(0, 2);
    
    console.log('Conversation stats:', {
      total: history.length,
      cleaned: cleanedHistory.length,
      meaningful: meaningfulMessages.length,
      userMessages: userMessages.length,
      assistantMessages: assistantMessages.length,
      sampleUserMessages: sampleUser.map(m => ({ 
        role: m.role, 
        contentLength: m.content?.length,
        contentPreview: m.content?.substring(0, 50)
      })),
      sampleAssistantMessages: sampleAssistant.map(m => ({ 
        role: m.role, 
        contentLength: m.content?.length,
        contentPreview: m.content?.substring(0, 50)
      })),
      firstFewMessages: history.slice(0, 5).map(m => ({
        role: m.role,
        hasContent: !!m.content,
        contentType: typeof m.content,
        contentLength: m.content?.length || 0,
        contentPreview: typeof m.content === 'string' ? m.content.substring(0, 30) : 'N/A'
      }))
    });
    
    // Use cleaned history, but ensure we have meaningful messages
    // Backend requires: at least 2 meaningful messages (>5 chars) and at least 1 user message (>10 chars)
    let historyToSend = cleanedHistory;
    
    // If cleaned history doesn't have enough meaningful messages, try to use original but filter better
    if (meaningfulMessages.length < 2 || userMessages.length === 0) {
      console.warn('Cleaned history might not pass backend validation, but sending anyway for backend to decide');
      // Still send cleaned history - backend will give proper error message
      historyToSend = cleanedHistory.length > 0 ? cleanedHistory : history;
    }
    
    if (historyToSend.length === 0) {
      console.error('No valid conversation history after cleaning');
      setError('No valid conversation history found. Cannot generate feedback.');
      setIsGeneratingFeedback(false);
      return;
    }
    
    // Final check - warn if we might not have enough
    if (meaningfulMessages.length < 2) {
      console.warn('⚠️ Warning: Might not have enough meaningful messages. Backend will validate.');
      console.warn('Meaningful messages:', meaningfulMessages.map(m => ({
        role: m.role,
        length: m.content.length,
        preview: m.content.substring(0, 50)
      })));
    }
    if (userMessages.length === 0) {
      console.warn('⚠️ Warning: No user messages found. Backend will validate.');
      console.warn('All messages:', cleanedHistory.map(m => ({
        role: m.role,
        length: m.content?.length || 0,
        preview: m.content?.substring(0, 30) || 'NO CONTENT'
      })));
    }
    
    console.log('📤 Sending to backend:', {
      totalMessages: historyToSend.length,
      meaningfulCount: meaningfulMessages.length,
      userCount: userMessages.length,
      assistantCount: assistantMessages.length,
      firstMessage: historyToSend[0],
      lastMessage: historyToSend[historyToSend.length - 1],
      sampleMessages: historyToSend.slice(0, 3).map(m => ({
        role: m.role,
        contentLength: m.content?.length || 0
      }))
    });
    
    try {
      setIsGeneratingFeedback(true);
      setError('');
      
      const requestBody = {
        conversation_history: historyToSend,
        job_role: selectedRole || 'Software Engineer',
        interview_type: selectedInterviewType || 'technical',
        candidate_name: candidateName || 'Candidate'
      };

      
      console.log('Sending feedback request:', {
        ...requestBody,
        conversation_history: `[${historyToSend.length} messages]`,
        firstMessage: historyToSend[0],
        lastMessage: historyToSend[historyToSend.length - 1]
      });
      
      // Add timeout for feedback generation (60 seconds)
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 60000);
      
      try {
        const response = await fetch(`${API_BASE_URL}/api/mock-interview/feedback`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          credentials: 'include',
          body: JSON.stringify(requestBody),
          signal: controller.signal
        });
        
        clearTimeout(timeoutId);
        console.log('Response status:', response.status);
        
        if (!response.ok) {
          let errorData;
          try {
            errorData = await response.json();
          } catch (e) {
            errorData = { message: `Server error (${response.status})` };
          }
          console.error('Feedback API error:', errorData);
          setError(errorData.message || `Failed to generate feedback (${response.status}). Please try again.`);
          setIsGeneratingFeedback(false);
          return;
        }
        
        const data = await response.json();
        console.log('Feedback received:', data);
        
      if (data.success) {
        setFeedbackData(data);
        setShowFeedback(true);
        setError(''); // Clear any previous errors

      } else {
          setError(data.message || 'Failed to generate feedback. Please try again.');
        }
      } catch (fetchError) {
        clearTimeout(timeoutId);
        if (fetchError.name === 'AbortError') {
          console.error('Feedback generation timeout');
          setError('Feedback generation is taking too long. Please try again or start a new interview.');
        } else {
          throw fetchError;
        }
      }
    } catch (error) {
      console.error('Error generating feedback:', error);
      setError(`Failed to generate feedback: ${error.message || 'Network error'}. Please check your connection and try again.`);
    } finally {
      setIsGeneratingFeedback(false);
    }
  };

  // End call manually
  const endCall = async () => {
    if (vapiRef.current) {
      try {
        clearVapiListeners();
        clearSpeakerTimeouts();
        await vapiRef.current.stop();
      } catch (error) {
        console.error('Error ending call:', error);
      }
      vapiRef.current = null;
    }
    
    setCallStatus('ended');
    setIsCallActive(false);
    setIsInterviewActive(false);
    
    // Generate feedback when manually ending call
    await generateFeedback();
  };

  // Reset to start new interview
  const resetInterview = () => {
    if (vapiRef.current) {
      try {
        clearVapiListeners();
        clearSpeakerTimeouts();
        vapiRef.current.stop();
      } catch (error) {
        console.error('Error stopping VAPI:', error);
      }
      vapiRef.current = null;
    }
    
    setShowForm(true);
    setCandidateName('');
    setSelectedRole('');
    setSelectedInterviewType('');
    setCurrentStep('name');
    setIsInterviewActive(false);
    setIsCallActive(false);
    setConversationHistory([]);
    conversationHistoryRef.current = [];
    transcriptAccumulatorRef.current = { assistant: '', user: '' };
    lastStoredMessageRef.current = { assistant: '', user: '' };
    setCallStatus('idle');
    setError('');
    setInterviewTimer(0);
    setQuestionsAskedCount(0);
    setShowFeedback(false);
    setFeedbackData(null);
    setIsGeneratingFeedback(false);
  };

  const startInterviewAgain = async () => {
    if (vapiRef.current) {
      try {
        clearVapiListeners();
        clearSpeakerTimeouts();
        vapiRef.current.stop();
      } catch (error) {
        console.error('Error stopping VAPI:', error);
      }
      vapiRef.current = null;
    }

    setShowFeedback(false);
    setFeedbackData(null);
    setConversationHistory([]);
    conversationHistoryRef.current = [];
    transcriptAccumulatorRef.current = { assistant: '', user: '' };
    lastStoredMessageRef.current = { assistant: '', user: '' };
    setQuestionsAskedCount(0);
    setInterviewTimer(0);
    setIsInterviewActive(false);
    setIsCallActive(false);
    setCallStatus('idle');
    setError('');
    setIsGeneratingFeedback(false);

    await startInterview();
  };
  
  // Timer effect
  useEffect(() => {
    let timerInterval;
    if (isInterviewActive && isCallActive) {
      timerInterval = setInterval(() => {
        setInterviewTimer(prev => prev + 1);
      }, 1000);
    } else {
      setInterviewTimer(0);
    }
    
    return () => {
      if (timerInterval) {
        clearInterval(timerInterval);
      }
    };
  }, [isInterviewActive, isCallActive]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (vapiRef.current) {
        try {
          clearVapiListeners();
          clearSpeakerTimeouts();
          vapiRef.current.stop();
        } catch (error) {
          console.error('Error cleaning up VAPI:', error);
        }
      }
    };
  }, []);

  // Format timer as MM:SS
  const formatTimer = (seconds) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  };

  const isRecruiterSpeaking = activeSpeaker === 'recruiter';
  const isCandidateSpeaking = activeSpeaker === 'candidate';

  const AudioWave = ({ isActive, bars = 5 }) => (
    <div className={`audio-wave ${isActive ? 'active' : 'inactive'}`} aria-hidden="true">
      {Array.from({ length: bars }).map((_, index) => (
        <span key={index} className="audio-wave-bar" />
      ))}
    </div>
  );

  const roleEntries = Object.entries(jobRoles);
  const normalizedSearchTerm = roleSearchTerm.trim().toLowerCase();
  const selectedRoleNormalized = selectedRole.trim().toLowerCase();
  const shouldFilterRoles = normalizedSearchTerm && normalizedSearchTerm !== selectedRoleNormalized;
  const filteredRoleEntries = shouldFilterRoles
    ? roleEntries.filter(([role]) => role.toLowerCase().includes(normalizedSearchTerm))
    : roleEntries;
  const normalizedInterviewTypeSearchTerm = interviewTypeSearchTerm.trim().toLowerCase();
  const selectedInterviewTypeLabel =
    interviewTypes.find((type) => type.value === selectedInterviewType)?.label || '';
  const selectedInterviewTypeNormalized = selectedInterviewTypeLabel.trim().toLowerCase();
  const shouldFilterInterviewTypes =
    normalizedInterviewTypeSearchTerm &&
    normalizedInterviewTypeSearchTerm !== selectedInterviewTypeNormalized;
  const filteredInterviewTypes = shouldFilterInterviewTypes
    ? interviewTypes.filter((type) => type.label.toLowerCase().includes(normalizedInterviewTypeSearchTerm))
    : interviewTypes;

  // Show form
  if (showForm) {
    return (
      <div className="mock-interview">
        <div className="mock-interview-container">
          <div className="mock-interview-header">
            <h1 className="section-title">Mock Interview</h1>
          </div>

          <div className="mock-interview-form card">
            {error && (
              <div className="error-message">
                <X size={16} />
                <span>{error}</span>
                <button onClick={() => setError('')}>×</button>
              </div>
            )}

            {currentStep === 'name' && (
              <div className="form-step">
                <h3>1. Enter Your Name</h3>
                <input
                  type="text"
                  className="form-input"
                  placeholder="Your name"
                  value={candidateName}
                  onChange={(e) => setCandidateName(e.target.value)}
                  onKeyPress={(e) => {
                    if (e.key === 'Enter' && candidateName.trim()) {
                      setShowRoleSuggestions(true);
                      setCurrentStep('role');
                    }
                  }}
                />
                <button
                  className="form-button primary"
                  onClick={() => {
                    setShowRoleSuggestions(true);
                    setCurrentStep('role');
                  }}
                  disabled={!candidateName.trim()}
                >
                  Next
                </button>
              </div>
            )}

            {currentStep === 'role' && (
              <div className="form-step">
                <h3>2. Choose Your Job Role</h3>
                <div className="role-search-bar-row">
                  <input
                    type="text"
                    className="form-input role-search-input-pattern"
                    placeholder="Search Job Role"
                    value={roleSearchTerm}
                    onFocus={() => setShowRoleSuggestions(true)}
                    onChange={(e) => {
                      setRoleSearchTerm(e.target.value);
                      setShowRoleSuggestions(true);
                    }}
                  />
                </div>
                {showRoleSuggestions && (
                  <div className="job-roles-pattern-panel">
                    <h4>Available Job Roles</h4>
                    <div className="job-roles-chip-list">
                      {filteredRoleEntries.map(([role, data]) => (
                        <button
                          key={`chip-${role}`}
                          type="button"
                          className={`job-role-chip ${selectedRole === role ? 'selected' : ''}`}
                          style={{ '--role-color': data.color }}
                          onClick={() => {
                            setSelectedRole(role);
                            setRoleSearchTerm(role);
                            setShowRoleSuggestions(true);
                          }}
                        >
                          {role}
                        </button>
                      ))}
                    </div>
                    {filteredRoleEntries.length === 0 && (
                      <p className="job-roles-empty">No job role found.</p>
                    )}
                  </div>
                )}
                <div className="form-actions">
                  <button
                    className="form-button secondary"
                    onClick={() => {
                      setShowRoleSuggestions(false);
                      setCurrentStep('name');
                    }}
                  >
                    <ArrowLeft size={16} />
                    Back
                  </button>
                  <button
                    className="form-button primary"
                    onClick={() => setCurrentStep('type')}
                    disabled={!selectedRole}
                  >
                    Next
                  </button>
                </div>
              </div>
            )}

            {currentStep === 'type' && selectedRole && (
              <div className="form-step">
                <h3>3. Select Interview Type</h3>
                <div className="role-search-bar-row">
                  <input
                    type="text"
                    className="form-input role-search-input-pattern"
                    placeholder="Search Interview Type"
                    value={interviewTypeSearchTerm}
                    onFocus={() => setShowInterviewTypeSuggestions(true)}
                    onChange={(e) => {
                      setInterviewTypeSearchTerm(e.target.value);
                      setShowInterviewTypeSuggestions(true);
                    }}
                  />
                </div>

                {showInterviewTypeSuggestions && (
                  <div className="job-roles-pattern-panel">
                    <h4>Available Interview Types</h4>
                    <div className="job-roles-chip-list">
                      {filteredInterviewTypes.map((type) => (
                        <button
                          key={type.value}
                          type="button"
                          className={`job-role-chip ${selectedInterviewType === type.value ? 'selected' : ''}`}
                          onClick={() => {
                            setSelectedInterviewType(type.value);
                            setInterviewTypeSearchTerm(type.label);
                            setShowInterviewTypeSuggestions(true);
                          }}
                        >
                          {type.label}
                        </button>
                      ))}
                    </div>
                    {filteredInterviewTypes.length === 0 && (
                      <p className="job-roles-empty">No interview type found.</p>
                    )}
                  </div>
                )}
                <div className="form-actions">
                  <button
                    className="form-button secondary"
                    onClick={() => setCurrentStep('role')}
                  >
                    <ArrowLeft size={16} />
                    Back
                  </button>
                  <button
                    className="form-button primary"
                    onClick={startInterview}
                    disabled={!selectedInterviewType || isLoading}
                  >
                    {isLoading ? (
                      <>
                        <Loader2 size={16} className="animate-spin" />
                        Starting Interview...
                      </>
                    ) : (
                      <>
                        <Phone size={16} />
                        Start Interview
                      </>
                    )}
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    );
  }

  // Show feedback screen
  if (showFeedback && feedbackData) {
    return (
      <div className="mock-interview">
        <div className="mock-interview-container">
          <div className="feedback-container card">
            <div className="feedback-header">
              <Trophy size={32} className="feedback-icon" />
              <h1 className="section-title">Interview Feedback</h1>
              <p className="section-subtitle">
                Your performance evaluation for {selectedRole} - {selectedInterviewType} Interview
              </p>
              <div className="feedback-header-actions">
                <button
                  className="form-button primary"
                  onClick={startInterviewAgain}
                >
                  <Phone size={16} />
                  Start Interview Again
                </button>
                <button
                  className="form-button secondary"
                  onClick={resetInterview}
                >
                  <ArrowLeft size={16} />
                  Start New Interview
                </button>
              </div>
            </div>

            {error && (
              <div className="error-message">
                <X size={16} />
                <span>{error}</span>
                <button onClick={() => setError('')}>×</button>
              </div>
            )}

            <div className="feedback-content">
              {feedbackData.feedback_data && (
                <>
                  {/* Job Role and Score Section */}
                  <div className="feedback-score-section" style={{
                    border: '1px solid #d1fae5',
                    borderRadius: '8px',
                    padding: '1rem',
                    marginBottom: '1.5rem',
                    backgroundColor: '#f0fdf4'
                  }}>
                    <div style={{ marginBottom: '0.75rem' }}>
                      <p style={{ margin: 0, fontSize: '0.9rem', color: '#065f46', fontWeight: '500' }}>
                        Job Role: <strong>{selectedRole || 'N/A'}</strong>
                      </p>
                    </div>
                    <div style={{ marginBottom: '0.75rem' }}>
                      <p style={{ margin: 0, fontSize: '1rem', color: '#065f46', fontWeight: '600' }}>
                        Total Score: <strong>{Math.round(feedbackData.feedback_data.overall_score || 0)}/100</strong>
                      </p>
                    </div>
                    <div style={{
                      width: '100%',
                      height: '16px',
                      backgroundColor: '#e5e7eb',
                      borderRadius: '8px',
                      overflow: 'hidden',
                      position: 'relative'
                    }}>
                      <div style={{
                        width: `${feedbackData.feedback_data.overall_score || 0}%`,
                        height: '100%',
                        backgroundColor: '#10b981',
                        transition: 'width 0.5s ease',
                        borderRadius: '8px'
                      }} />
                    </div>
                  </div>

                  <div
                    className="feedback-strengths-grid"
                    style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem', marginBottom: '1.5rem' }}
                  >
                    {/* Strengths Section */}
                    {feedbackData.feedback_data.key_strengths && feedbackData.feedback_data.key_strengths.length > 0 ? (
                      <div className="feedback-section" style={{
                        border: '1px solid #d1fae5',
                        borderRadius: '8px',
                        padding: '1rem',
                        backgroundColor: '#f0fdf4',
                        minHeight: '100px'
                      }}>
                        <h3 className="feedback-section-title" style={{ color: '#065f46', marginBottom: '0.75rem' }}>
                          <CheckCircle size={18} style={{ color: '#10b981', marginRight: '0.5rem' }} />
                          Strengths
                        </h3>
                        <ul className="feedback-list" style={{ listStyle: 'none', padding: 0, margin: 0 }}>
                          {feedbackData.feedback_data.key_strengths.map((strength, idx) => (
                            <li key={idx} style={{
                              marginBottom: '0.5rem',
                              paddingLeft: '1.25rem',
                              position: 'relative',
                              color: '#065f46',
                              fontSize: '0.875rem',
                              lineHeight: '1.5',
                              wordWrap: 'break-word',
                              overflowWrap: 'break-word'
                            }}>
                              <span style={{
                                position: 'absolute',
                                left: 0,
                                color: '#10b981'
                              }}>•</span>
                              {strength}
                            </li>
                          ))}
                        </ul>
                      </div>
                    ) : (
                      <div className="feedback-section" style={{
                        border: '1px solid #d1fae5',
                        borderRadius: '8px',
                        padding: '1rem',
                        backgroundColor: '#f0fdf4',
                        minHeight: '100px'
                      }}>
                        <h3 className="feedback-section-title" style={{ color: '#065f46', marginBottom: '0.75rem' }}>
                          <CheckCircle size={18} style={{ color: '#10b981', marginRight: '0.5rem' }} />
                          Strengths
                        </h3>
                        <p style={{ color: '#6b7280', fontSize: '0.875rem', margin: 0 }}>No strengths identified.</p>
                      </div>
                    )}

                    {/* Weaknesses Section */}
                    {(feedbackData.feedback_data.weaknesses || feedbackData.feedback_data.areas_for_improvement) && 
                     (feedbackData.feedback_data.weaknesses || feedbackData.feedback_data.areas_for_improvement).length > 0 && (
                      <div className="feedback-section" style={{
                        border: '1px solid #fee2e2',
                        borderRadius: '8px',
                        padding: '1rem',
                        backgroundColor: '#fef2f2'
                      }}>
                        <h3 className="feedback-section-title" style={{ color: '#991b1b', marginBottom: '0.75rem' }}>
                          <Target size={18} style={{ color: '#ef4444', marginRight: '0.5rem' }} />
                          Weaknesses
                        </h3>
                        <ul className="feedback-list" style={{ listStyle: 'none', padding: 0, margin: 0 }}>
                          {(feedbackData.feedback_data.weaknesses || feedbackData.feedback_data.areas_for_improvement).map((weakness, idx) => (
                            <li key={idx} style={{
                              marginBottom: '0.5rem',
                              paddingLeft: '1.25rem',
                              position: 'relative',
                              color: '#991b1b',
                              fontSize: '0.875rem',
                              lineHeight: '1.5',
                              wordWrap: 'break-word',
                              overflowWrap: 'break-word'
                            }}>
                              <span style={{
                                position: 'absolute',
                                left: 0,
                                color: '#ef4444'
                              }}>•</span>
                              {weakness}
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </div>

                  {/* How to Improve Section */}
                  {(feedbackData.feedback_data.how_to_improve || feedbackData.feedback_data.recommendations) && 
                   (feedbackData.feedback_data.how_to_improve || feedbackData.feedback_data.recommendations).length > 0 && (
                    <div className="feedback-section" style={{
                      border: '1px solid #e5e7eb',
                      borderRadius: '8px',
                      padding: '1rem',
                      marginBottom: '1.5rem',
                      backgroundColor: '#ffffff'
                    }}>
                      <h3 className="feedback-section-title" style={{ marginBottom: '0.75rem', color: '#1f2937' }}>
                        <Brain size={18} style={{ marginRight: '0.5rem', color: '#2E86AB' }} />
                        How to Improve (Actionable Suggestions)
                      </h3>
                      <ul className="feedback-list" style={{ listStyle: 'none', padding: 0, margin: 0 }}>
                        {(feedbackData.feedback_data.how_to_improve || feedbackData.feedback_data.recommendations).map((item, idx) => (
                          <li key={idx} style={{
                            marginBottom: '0.75rem',
                            paddingLeft: '1.25rem',
                            position: 'relative',
                            color: '#374151',
                            fontSize: '0.875rem',
                            lineHeight: '1.6',
                            wordWrap: 'break-word',
                            overflowWrap: 'break-word',
                            paddingRight: '0.5rem'
                          }}>
                            <span style={{
                              position: 'absolute',
                              left: 0,
                              color: '#2E86AB',
                              fontWeight: 'bold'
                            }}>•</span>
                            {item}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}

                  {/* Recommended Topics Section */}
                  {feedbackData.feedback_data.recommended_topics && feedbackData.feedback_data.recommended_topics.length > 0 && (
                    <div className="feedback-section" style={{
                      border: '1px solid #e5e7eb',
                      borderRadius: '8px',
                      padding: '1rem',
                      backgroundColor: '#ffffff'
                    }}>
                      <h3 className="feedback-section-title" style={{ marginBottom: '0.75rem', color: '#1f2937' }}>
                        <BookOpen size={18} style={{ marginRight: '0.5rem', color: '#0A2540' }} />
                        Recommended Next Topics to Prepare
                      </h3>
                      <ul className="feedback-list" style={{ listStyle: 'none', padding: 0, margin: 0 }}>
                        {feedbackData.feedback_data.recommended_topics.map((topic, idx) => (
                          <li key={idx} style={{
                            marginBottom: '0.5rem',
                            paddingLeft: '1.25rem',
                            position: 'relative',
                            color: '#374151',
                            fontSize: '0.875rem',
                            lineHeight: '1.5',
                            wordWrap: 'break-word',
                            overflowWrap: 'break-word'
                          }}>
                            <span style={{
                              position: 'absolute',
                              left: 0,
                              color: '#0A2540',
                              fontWeight: 'bold'
                            }}>•</span>
                            {topic}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </>
              )}

              {feedbackData.feedback && !feedbackData.feedback_data && (
                <div className="feedback-section">
                  <div className="feedback-text" style={{ whiteSpace: 'pre-wrap' }}>
                    {feedbackData.feedback}
                  </div>
                </div>
              )}
            </div>

            <div className="feedback-actions">
              <button
                className="form-button primary"
                onClick={startInterviewAgain}
              >
                <Phone size={16} />
                Start Interview Again
              </button>
              <button
                className="form-button secondary"
                onClick={resetInterview}
              >
                <ArrowLeft size={16} />
                Start Again
              </button>
              <button
                className="form-button secondary"
                onClick={resetInterview}
              >
                <Play size={16} />
                Start New Interview
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // Show error screen if feedback generation failed
  if (callStatus === 'ended' && !showFeedback && error && !isGeneratingFeedback) {
    return (
      <div className="mock-interview">
        <div className="mock-interview-container">
          <div className="feedback-container card">
            <div className="feedback-header">
              <X size={32} className="error-icon" style={{ color: 'var(--error-color, #ef4444)' }} />
              <h1 className="section-title">Feedback Generation Failed</h1>
            </div>
            
            <div className="error-message" style={{ margin: '20px 0' }}>
              <X size={16} />
              <span>{error}</span>
            </div>
            
            <div className="feedback-actions" style={{ marginTop: '30px' }}>
              <button
                className="form-button primary"
                onClick={async () => {
                  setError('');
                  await generateFeedback();
                }}
              >
                <Loader2 size={16} />
                Retry Feedback Generation
              </button>
              <button
                className="form-button secondary"
                onClick={resetInterview}
                style={{ marginLeft: '10px' }}
              >
                <ArrowLeft size={16} />
                Start New Interview
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // Show loading/generating feedback screen
  if (isGeneratingFeedback || (callStatus === 'ended' && !showFeedback && !error)) {
    return (
      <div className="mock-interview">
        <div className="mock-interview-container">
          <div className="loading-container">
            <Loader2 size={48} className="animate-spin" />
            <p>Generating your feedback...</p>
            <p className="loading-subtitle">This may take a few moments</p>
            {error && (
              <div className="error-message" style={{ marginTop: '20px', maxWidth: '500px' }}>
                <X size={16} />
                <span>{error}</span>
              </div>
            )}
          </div>
        </div>
      </div>
    );
  }

  // Show interview interface
  if (isInterviewActive) {
    return (
      <div className="mock-interview">
        <div className="mock-interview-container">
            <div className="interview-active">
              {/* Header with Title and Timer */}
              <div className="interview-session-header">
                <h1 className="session-title">AI Interview Session</h1>
                <div className="session-timer">
                  <Clock size={18} />
                  <span>{formatTimer(interviewTimer)}</span>
                </div>
              </div>

              {/* Two Panel Layout - Recruiter and Candidate */}
              <div className="interview-panels">
                {/* AI Recruiter Panel */}
                <div className={`interview-panel recruiter-panel ${isRecruiterSpeaking ? 'speaking' : ''}`}>
                  <div className="panel-avatar recruiter-avatar-large">
                    <User size={48} />
                  </div>
                  <div className="panel-label-row">
                    <div className="panel-label">AI Recruiter</div>
                    <AudioWave isActive={isRecruiterSpeaking} />
                  </div>
                  {isRecruiterSpeaking && currentRecruiterText && (
                    <div className="panel-transcript">{currentRecruiterText}</div>
                  )}
                </div>

                {/* Candidate Panel */}
                <div className={`interview-panel candidate-panel ${isCandidateSpeaking ? 'speaking' : ''}`}>
                  <div className="panel-avatar candidate-avatar-large">
                    <div className="candidate-initial">{candidateName.charAt(0).toUpperCase()}</div>
                  </div>
                  <div className="panel-label-row">
                    <div className="panel-label">{candidateName}</div>
                    <AudioWave isActive={isCandidateSpeaking} />
                  </div>
                  {isCandidateSpeaking && currentCandidateText && (
                    <div className="panel-transcript">{currentCandidateText}</div>
                  )}
                </div>
              </div>

              {/* Call Controls */}
              <div className="call-controls">
                <button
                  className={`control-button mic-button ${isMuted ? 'muted' : ''}`}
                  onClick={() => setIsMuted(!isMuted)}
                  title={isMuted ? 'Unmute' : 'Mute'}
                >
                  {isMuted ? <MicOff size={24} /> : <Mic size={24} />}
                </button>
                <button
                  className="control-button end-call-button"
                  onClick={endCall}
                  title="End Interview"
                >
                  <PhoneOff size={24} />
                </button>
              </div>

              {/* Interview Status */}
              <div className="interview-status">
                <span>Interview in Progress...</span>
              </div>

            </div>
        </div>
      </div>
    );
  }

  return (
    <div className="mock-interview">
      <div className="mock-interview-container">
        <div className="loading-container">
          <Loader2 size={48} className="animate-spin" />
          <p>Loading...</p>
        </div>
      </div>
    </div>
  );
};

export default MockInterview;

