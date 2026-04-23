document.addEventListener('DOMContentLoaded', () => {
    const extractBtn = document.getElementById('extractBtn');
    const resultsDiv = document.getElementById('results');
    const loader = document.getElementById('loader');
    const tabs = document.querySelectorAll('.tab');
    const tabContents = document.querySelectorAll('.tab-content');
    
    // Google Sheets configuration elements
    const enableGoogleSheets = document.getElementById('enableGoogleSheets');
    const apiKeyInput = document.getElementById('apiKey');
    const spreadsheetIdInput = document.getElementById('spreadsheetId');
    const sheetNameInput = document.getElementById('sheetName');
    const saveConfigBtn = document.getElementById('saveConfig');
    const configStatusDiv = document.getElementById('configStatus');

    let currentTabId = null;
    let statusCheckInterval = null;

    // Get current tab on load
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (tabs[0]) {
            currentTabId = tabs[0].id;
        }
    });

    // Tab switching functionality
    tabs.forEach(tab => {
        tab.addEventListener('click', () => {
            // Remove active class from all tabs and contents
            tabs.forEach(t => t.classList.remove('active'));
            tabContents.forEach(content => content.classList.remove('active'));
            
            // Add active class to clicked tab
            tab.classList.add('active');
            
            // Show corresponding content
            const tabName = tab.dataset.tab;
            document.getElementById(`${tabName}-tab`).classList.add('active');
        });
    });

    // Load existing configuration on startup
    loadGoogleSheetsConfig();
    
    // Initialize default configuration if needed
    initializeDefaultConfiguration();

    // Save configuration
    saveConfigBtn.addEventListener('click', saveGoogleSheetsConfig);
    
    // Add test connection button functionality
    const testBtn = document.getElementById('testConnection');
    if (testBtn) {
        testBtn.addEventListener('click', testGoogleSheetsConnection);
    }

    // Resume AI functionality
    initializeResumeAI();

    // Function to load Google Sheets configuration
    async function loadGoogleSheetsConfig() {
        try {
            const result = await chrome.storage.local.get(['googleSheetsConfig']);
            const config = result.googleSheetsConfig || {};
            
            // Auto-enable if we have both API key and spreadsheet ID configured
            const hasApiKey = config.apiKey || 'YOUR_GEMINI_API_KEY';
            const hasSpreadsheetId = config.spreadsheetId || 'YOUR_GOOGLE_SHEET_ID';
            
            enableGoogleSheets.checked = config.enabled !== undefined ? config.enabled : (hasApiKey && hasSpreadsheetId);
            
            // Pre-fill with the user's specific API key and spreadsheet ID if not already configured
            apiKeyInput.value = config.apiKey || 'YOUR_GEMINI_API_KEY';
            spreadsheetIdInput.value = config.spreadsheetId || 'YOUR_GOOGLE_SHEET_ID';
            sheetNameInput.value = config.sheetName || 'Sheet1'; // FIX: Use correct sheet name
            
            // Update input states based on enabled status
            updateInputStates();
            
            // Auto-enable Google Sheets integration if both API key and spreadsheet ID are available
            if (apiKeyInput.value && spreadsheetIdInput.value && !config.enabled) {
                enableGoogleSheets.checked = true;
                // Auto-save the configuration if it's the first time
                if (!config.apiKey && !config.spreadsheetId) {
                    setTimeout(() => saveGoogleSheetsConfig(), 500);
                }
            }
            
            // Show helpful message if using pre-filled configuration
            if (!config.apiKey && !config.spreadsheetId) {
                showConfigStatus('✅ Pre-configured with your API key and Google Sheets ID. Ready to use!', 'success');
            } else if (!config.apiKey) {
                showConfigStatus('Pre-filled with your API key. Google Sheets integration ready!', 'info');
            } else if (!config.spreadsheetId) {
                showConfigStatus('Pre-filled with your Google Sheets ID. Just add your API key to get started!', 'info');
            }
        } catch (error) {
            console.error('Error loading config:', error);
            showConfigStatus('Error loading configuration', 'error');
        }
    }

    // Function to save Google Sheets configuration
    async function saveGoogleSheetsConfig() {
        try {
            const config = {
                enabled: enableGoogleSheets.checked,
                apiKey: apiKeyInput.value.trim(),
                spreadsheetId: spreadsheetIdInput.value.trim(),
                sheetName: sheetNameInput.value.trim() || 'Sheet1' // FIX: Use correct sheet name
            };

            await chrome.storage.local.set({ googleSheetsConfig: config });
            showConfigStatus('Configuration saved successfully!', 'success');
            
            // Initialize headers if configuration is complete and enabled
            if (config.enabled && config.apiKey && config.spreadsheetId) {
                await initializeHeaders(config);
            }
        } catch (error) {
            console.error('Error saving config:', error);
            showConfigStatus('Error saving configuration', 'error');
        }
    }

    // Function to initialize Google Sheets headers
    async function initializeHeaders(config) {
        try {
            // This will be called by the content script when needed
            showConfigStatus('Configuration saved! Headers will be initialized on next extraction.', 'success');
        } catch (error) {
            console.error('Error initializing headers:', error);
            showConfigStatus('Configuration saved, but header initialization failed', 'error');
        }
    }

    // Function to initialize default configuration
    async function initializeDefaultConfiguration() {
        try {
            const result = await chrome.storage.local.get(['googleSheetsConfig']);
            const config = result.googleSheetsConfig;
            
            // If no configuration exists, create default one
            if (!config) {
                const defaultConfig = {
                    enabled: true,
                    apiKey: 'YOUR_GEMINI_API_KEY',
                    spreadsheetId: 'YOUR_GOOGLE_SHEET_ID',
                    sheetName: 'Sheet1' // FIX: Use correct sheet name
                };
                
                await chrome.storage.local.set({ googleSheetsConfig: defaultConfig });
                console.log('✅ Default Google Sheets configuration initialized');
            }
        } catch (error) {
            console.error('Error initializing default configuration:', error);
        }
    }

    // Function to show configuration status
    function showConfigStatus(message, type) {
        configStatusDiv.innerHTML = `<div class="status ${type}">${message}</div>`;
        setTimeout(() => {
            configStatusDiv.innerHTML = '';
        }, 3000);
    }

    // Function to test Google Sheets connection
    async function testGoogleSheetsConnection() {
        try {
            showConfigStatus('Testing Google Sheets connection...', 'info');
            
            const config = {
                enabled: enableGoogleSheets.checked,
                apiKey: apiKeyInput.value.trim(),
                spreadsheetId: spreadsheetIdInput.value.trim(),
                sheetName: sheetNameInput.value.trim() || 'Sheet1' // FIX: Use correct sheet name
            };

            if (!config.apiKey || !config.spreadsheetId) {
                showConfigStatus('Please fill in API Key and Spreadsheet ID', 'error');
                return;
            }

            // Test by reading the first row of the sheet
            const url = `https://sheets.googleapis.com/v4/spreadsheets/${config.spreadsheetId}/values/${encodeURIComponent(config.sheetName)}!A1:K1?key=${config.apiKey}`;
            
            const response = await fetch(url);
            
            if (response.ok) {
                showConfigStatus('✅ Google Sheets connection successful!', 'success');
            } else {
                const errorData = await response.json().catch(() => ({}));
                let errorMessage = 'Connection failed';
                
                if (response.status === 403) {
                    errorMessage = 'Permission denied. Check API key and sheet permissions.';
                } else if (response.status === 404) {
                    errorMessage = 'Sheet not found. Check spreadsheet ID and sheet name.';
                }
                
                showConfigStatus(`❌ ${errorMessage}`, 'error');
            }
        } catch (error) {
            console.error('Test connection error:', error);
            showConfigStatus('❌ Connection test failed: ' + error.message, 'error');
        }
    }

    // Function to update input states based on enabled checkbox
    function updateInputStates() {
        const inputs = [apiKeyInput, spreadsheetIdInput, sheetNameInput];
        inputs.forEach(input => {
            input.disabled = !enableGoogleSheets.checked;
        });
        saveConfigBtn.disabled = !enableGoogleSheets.checked;
    }

    // Enable/disable inputs based on checkbox
    enableGoogleSheets.addEventListener('change', updateInputStates);

    // Function to check extraction status
    async function checkExtractionStatus() {
        if (!currentTabId) return;

        try {
            const response = await new Promise((resolve) => {
                chrome.runtime.sendMessage({
                    action: 'get_extraction_status',
                    tabId: currentTabId
                }, resolve);
            });

            if (response && response.success && response.status) {
                const status = response.status;
                console.log('Status check:', status);

                switch (status.status) {
                    case 'starting':
                        // Keep showing loading
                        break;
                    
                    case 'completed':
                        clearInterval(statusCheckInterval);
                        showResults(status.data);
                        break;
                    
                    case 'error':
                        clearInterval(statusCheckInterval);
                        showError(status.error);
                        break;
                }
            }
        } catch (error) {
            console.error('Error checking status:', error);
        }
    }

    // Function to show enhanced results with strategic intelligence
    function showResults(data) {
        loader.style.display = 'none';
        extractBtn.disabled = false;
        extractBtn.textContent = 'Extract Profile Data';

        if (data) {
            let displayString = `🎯 Strategic Intelligence Extraction Complete!\n\n`;
            
            // === BASIC PROFILE DATA ===
            displayString += `📋 BASIC PROFILE:\n`;
            displayString += `• Name: ${data.fullName || 'Not found'}\n`;
            displayString += `• Current Role: ${data.currentDesignation || 'Not found'}\n`;
            displayString += `• Company: ${data.currentOrganization || 'Not found'}\n`;
            displayString += `• Headline: ${data.headline || 'Not found'}\n`;
            
            if (data.confidence) {
                displayString += `• AI Confidence: ${Math.round(data.confidence * 100)}%\n`;
            }

            // === STRATEGIC INTELLIGENCE ===
            if (data.strategicIntelligence) {
                const strategic = data.strategicIntelligence;
                displayString += `\n🧠 STRATEGIC INTELLIGENCE:\n`;
                displayString += `• Strategic Confidence: ${Math.round((strategic.confidenceScore || 0) * 100)}%\n`;
                
                // Recruiter Intelligence
                if (strategic.recruiterIntelligence?.isRecruiter) {
                    displayString += `• 🎯 RECRUITER DETECTED (${strategic.recruiterIntelligence.type})\n`;
                    if (strategic.recruiterIntelligence.hiringFocus) {
                        displayString += `• Hiring Focus: ${strategic.recruiterIntelligence.hiringFocus.substring(0, 50)}...\n`;
                    }
                }
                
                // Activity Intelligence
                if (strategic.tier2?.recentActivity?.length > 0) {
                    const activity = strategic.tier2.recentActivity[0];
                    displayString += `• Recent Activity: ${activity.type} (${Math.round(activity.relevanceScore * 100)}% relevant)\n`;
                }
                
                // Mutual Connections
                if (strategic.tier2?.mutualConnections?.count > 0) {
                    displayString += `• Mutual Connections: ${strategic.tier2.mutualConnections.count}\n`;
                }
                
                // Email Patterns
                if (strategic.tier3?.emailPatterns?.length > 0) {
                    displayString += `• Top Email Pattern: ${strategic.tier3.emailPatterns[0].pattern}\n`;
                }
            }

            // === STRATEGIC MESSAGES ===
            if (data.strategicMessages) {
                const messages = data.strategicMessages;
                displayString += `\n💬 STRATEGIC OUTREACH MESSAGES:\n`;
                displayString += `• Framework: ${messages.source || 'P.R.E.P'}\n`;
                displayString += `• Confidence: ${messages.confidence || 'medium'}\n`;
                displayString += `• Semantic Matches: ${messages.semanticMatches || 0}\n`;
                
                if (messages.strategicIntelligence?.confidenceScore) {
                    displayString += `• Intelligence Score: ${Math.round(messages.strategicIntelligence.confidenceScore * 100)}%\n`;
                }
                
                displayString += `\n📱 LinkedIn Message (${messages.linkedinMessage?.length || 0}/300):\n`;
                displayString += `"${messages.linkedinMessage || 'Not generated'}"\n`;
                
                displayString += `\n📧 Email Subject:\n`;
                displayString += `"${messages.emailSubject || 'Not generated'}"\n`;
                
                displayString += `\n📨 Email Body:\n`;
                displayString += `"${(messages.emailBody || 'Not generated').substring(0, 200)}${messages.emailBody?.length > 200 ? '...' : ''}"\n`;
                
                displayString += `\n🎯 Personalization Strategy:\n`;
                displayString += `${messages.personalizationUsed || 'Standard approach'}\n`;
                
                // Show reasoning if available
                if (messages.reasoning?.personalizationLevel) {
                    displayString += `• Level: ${messages.reasoning.personalizationLevel}\n`;
                }
                
                if (messages.reasoning?.primaryHook) {
                    displayString += `• Primary Hook: ${messages.reasoning.primaryHook.type || 'general'}\n`;
                }
            }
            
            // Show Google Sheets status
            if (enableGoogleSheets.checked) {
                displayString += `\n📊 GOOGLE SHEETS INTEGRATION:\n`;
                if (data.googleSheetsStatus === 'success') {
                    displayString += `✅ Data exported successfully with ${34} columns\n`;
                } else if (data.googleSheetsStatus === 'failed') {
                    displayString += `❌ Export failed - ${data.googleSheetsError || 'Unknown error'}\n`;
                } else if (data.googleSheetsStatus === 'error') {
                    displayString += `⚠️ Export error - ${data.googleSheetsError || 'Unknown error'}\n`;
                } else {
                    displayString += `⏳ Export attempted - check spreadsheet\n`;
                }
            }
            
            // Performance metrics
            if (data.strategicMessages?.reasoning?.strategicConfidence) {
                displayString += `\n📈 SYSTEM METRICS:\n`;
                displayString += `• Strategic Confidence: ${Math.round(data.strategicMessages.reasoning.strategicConfidence * 100)}%\n`;
                
                if (data.strategicMessages.reasoning.tierDataQuality) {
                    const quality = data.strategicMessages.reasoning.tierDataQuality;
                    displayString += `• Data Quality: T1(${quality.tier1}) T2(${quality.tier2}) T3(${quality.tier3})\n`;
                }
            }
            
            resultsDiv.textContent = displayString;
            resultsDiv.style.color = '#c8e6c9'; // Green for success
        } else {
            showError('No data received');
        }
    }

    // Function to show error
    function showError(error) {
        loader.style.display = 'none';
        extractBtn.disabled = false;
        extractBtn.textContent = 'Extract Profile Data';
        resultsDiv.textContent = `❌ Error: ${error}\n\nPlease try again or ensure you're on a LinkedIn profile page.`;
        resultsDiv.style.color = '#ffcdd2'; // Red for error
    }

    // Main extraction button click handler
    extractBtn.addEventListener('click', async () => {
        resultsDiv.textContent = '';
        resultsDiv.style.color = '#fff'; // Reset color
        loader.style.display = 'block';
        extractBtn.disabled = true;
        extractBtn.textContent = 'Extracting...';

        // Clear any existing status check
        if (statusCheckInterval) {
            clearInterval(statusCheckInterval);
        }

        try {
            // Get current active tab
            const tabs = await chrome.tabs.query({
                active: true,
                currentWindow: true
            });

            if (!tabs[0]) {
                showError('Could not access current tab');
                return;
            }

            currentTabId = tabs[0].id;

            // Verify the user is on a valid LinkedIn profile page
            if (!tabs[0].url || !tabs[0].url.includes('linkedin.com/in/')) {
                showError('Please navigate to a valid LinkedIn profile page.\n\nMake sure you\'re on a page like:\nlinkedin.com/in/username');
                return;
            }

            // Initiate extraction
            const response = await new Promise((resolve) => {
                chrome.runtime.sendMessage({
                    action: 'initiate_extraction',
                    tabId: currentTabId
                }, resolve);
            });

            if (response && response.success) {
                console.log('Extraction initiated successfully');
                
                // Start polling for status
                statusCheckInterval = setInterval(checkExtractionStatus, 1000); // Check every second
                
                // Also set a timeout to stop polling after 2 minutes
                setTimeout(() => {
                    if (statusCheckInterval) {
                        clearInterval(statusCheckInterval);
                        showError('Extraction timed out. Please try again.');
                    }
                }, 120000); // 2 minutes timeout
                
            } else {
                showError(response?.error || 'Failed to initiate extraction');
            }

        } catch (error) {
            console.error("Error in extraction:", error);
            showError('Could not access browser tab information.\n\nPlease refresh the page and try again.');
        }
    });

    // =================================================================
    // RESUME AI INTELLIGENCE SYSTEM
    // =================================================================

    function initializeResumeAI() {
        const uploadZone = document.getElementById('uploadZone');
        const fileInput = document.getElementById('resumeFileInput');
        const resumeAnalysis = document.getElementById('resumeAnalysis');
        const resumeInsights = document.getElementById('resumeInsights');
        const analyzeBtn = document.getElementById('analyzeResumeBtn');
        const clearBtn = document.getElementById('clearResumeBtn');
        const saveAIConfigBtn = document.getElementById('saveAIConfigBtn');
        const personalValue = document.getElementById('personalValue');
        const careerGoals = document.getElementById('careerGoals');
        const aiStatus = document.getElementById('aiStatus');

        // Load existing AI configuration
        loadAIConfiguration();

        // Upload zone click handler
        uploadZone.addEventListener('click', () => {
            fileInput.click();
        });

        // Drag and drop handlers
        uploadZone.addEventListener('dragover', (e) => {
            e.preventDefault();
            uploadZone.classList.add('drag-over');
        });

        uploadZone.addEventListener('dragleave', () => {
            uploadZone.classList.remove('drag-over');
        });

        uploadZone.addEventListener('drop', (e) => {
            e.preventDefault();
            uploadZone.classList.remove('drag-over');
            const files = e.dataTransfer.files;
            if (files.length > 0) {
                handleResumeUpload(files[0]);
            }
        });

        // File input change handler
        fileInput.addEventListener('change', (e) => {
            if (e.target.files.length > 0) {
                handleResumeUpload(e.target.files[0]);
            }
        });

        // Button handlers
        analyzeBtn.addEventListener('click', performDeepResumeAnalysis);
        clearBtn.addEventListener('click', clearResumeData);
        saveAIConfigBtn.addEventListener('click', saveAIConfiguration);

        async function handleResumeUpload(file) {
            try {
                showAIStatus('📄 Processing resume...', 'info');
                
                const text = await extractTextFromFile(file);
                const analysis = await analyzeResumeContent(text);
                
                // Store resume data
                await chrome.storage.local.set({
                    resumeData: {
                        fileName: file.name,
                        content: text,
                        analysis: analysis,
                        uploadDate: new Date().toISOString()
                    }
                });

                displayResumeAnalysis(analysis);
                resumeAnalysis.style.display = 'block';
                showAIStatus('✅ Resume uploaded and analyzed successfully!', 'success');
                
            } catch (error) {
                console.error('Resume upload error:', error);
                showAIStatus('❌ Error processing resume: ' + error.message, 'error');
            }
        }

        async function extractTextFromFile(file) {
            return new Promise((resolve, reject) => {
                const reader = new FileReader();
                
                reader.onload = (e) => {
                    const text = e.target.result;
                    resolve(text);
                };
                
                reader.onerror = () => {
                    reject(new Error('Failed to read file'));
                };
                
                // For now, only handle text files directly
                // In production, you'd use libraries like PDF.js for PDF parsing
                if (file.type === 'text/plain') {
                    reader.readAsText(file);
                } else {
                    // Simplified approach - ask user to copy-paste
                    reject(new Error('Please convert your resume to .txt format or copy-paste the content'));
                }
            });
        }

        async function analyzeResumeContent(text) {
            try {
                // Extract key sections using pattern matching
                const analysis = {
                    summary: extractSummary(text),
                    experience: extractExperience(text),
                    skills: extractSkills(text),
                    education: extractEducation(text),
                    achievements: extractAchievements(text),
                    keywords: extractKeywords(text),
                    embeddings: await generateEmbeddings(text)
                };

                return analysis;
            } catch (error) {
                console.error('Resume analysis error:', error);
                return { error: error.message };
            }
        }

        function extractSummary(text) {
            const summaryPatterns = [
                /summary[\s\S]*?(?=\n\s*[A-Z]|\n\s*$|experience|education)/i,
                /profile[\s\S]*?(?=\n\s*[A-Z]|\n\s*$|experience|education)/i,
                /objective[\s\S]*?(?=\n\s*[A-Z]|\n\s*$|experience|education)/i
            ];

            for (const pattern of summaryPatterns) {
                const match = text.match(pattern);
                if (match) {
                    return match[0].replace(/summary|profile|objective/i, '').trim();
                }
            }

            // Fallback: use first paragraph
            const paragraphs = text.split('\n\n');
            return paragraphs[0]?.substring(0, 300) || '';
        }

        function extractExperience(text) {
            const experiences = [];
            const experienceSection = text.match(/experience[\s\S]*?(?=education|skills|$)/i);
            
            if (experienceSection) {
                const lines = experienceSection[0].split('\n');
                let currentExp = null;
                
                for (const line of lines) {
                    const trimmed = line.trim();
                    if (trimmed.length < 3) continue;
                    
                    // Look for job titles or company names
                    if (trimmed.match(/\b(manager|engineer|developer|analyst|director|lead|senior|specialist|coordinator)\b/i)) {
                        if (currentExp) experiences.push(currentExp);
                        currentExp = { title: trimmed, details: [] };
                    } else if (currentExp && trimmed.length > 10) {
                        currentExp.details.push(trimmed);
                    }
                }
                
                if (currentExp) experiences.push(currentExp);
            }
            
            return experiences.slice(0, 5); // Top 5 experiences
        }

        function extractSkills(text) {
            const skillsSection = text.match(/skills[\s\S]*?(?=education|experience|$)/i);
            const allSkills = [];
            
            if (skillsSection) {
                const skills = skillsSection[0]
                    .replace(/skills/i, '')
                    .split(/[,\n•·-]/)
                    .map(s => s.trim())
                    .filter(s => s.length > 2 && s.length < 30);
                    
                allSkills.push(...skills);
            }
            
            // Also extract skills from experience descriptions
            const techSkills = text.match(/\b(javascript|python|java|react|node|sql|aws|azure|docker|kubernetes|machine learning|ai|data science|product management|marketing|sales|finance)\b/gi);
            if (techSkills) {
                allSkills.push(...techSkills.map(s => s.toLowerCase()));
            }
            
            // Remove duplicates and return top skills
            return [...new Set(allSkills)].slice(0, 15);
        }

        function extractEducation(text) {
            const educationSection = text.match(/education[\s\S]*?(?=experience|skills|$)/i);
            const education = [];
            
            if (educationSection) {
                const lines = educationSection[0].split('\n');
                for (const line of lines) {
                    const trimmed = line.trim();
                    if (trimmed.match(/\b(university|college|institute|school|degree|bachelor|master|phd|mba)\b/i)) {
                        education.push(trimmed);
                    }
                }
            }
            
            return education;
        }

        function extractAchievements(text) {
            const achievements = [];
            const patterns = [
                /\b\d+%\s+\w+/g, // Percentage improvements
                /\$[\d,]+/g, // Dollar amounts
                /\b\d+[kK]\+?\b/g, // Large numbers (10k+)
                /increased|improved|reduced|optimized|led|managed|achieved/gi
            ];
            
            for (const pattern of patterns) {
                const matches = text.match(pattern);
                if (matches) {
                    achievements.push(...matches);
                }
            }
            
            return [...new Set(achievements)].slice(0, 10);
        }

        function extractKeywords(text) {
            const words = text.toLowerCase()
                .replace(/[^\w\s]/g, ' ')
                .split(/\s+/)
                .filter(word => word.length > 3);
                
            const wordCount = {};
            words.forEach(word => {
                wordCount[word] = (wordCount[word] || 0) + 1;
            });
            
            return Object.entries(wordCount)
                .sort(([,a], [,b]) => b - a)
                .slice(0, 20)
                .map(([word]) => word);
        }

        async function generateEmbeddings(text) {
            try {
                // Use Gemini to generate semantic embeddings
                const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/text-embedding-004:embedContent?key=YOUR_GEMINI_API_KEY`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({
                        model: 'models/text-embedding-004',
                        content: {
                            parts: [{ text: text.substring(0, 1000) }] // Limit text length
                        }
                    })
                });

                if (response.ok) {
                    const data = await response.json();
                    return data.embedding?.values || [];
                }
            } catch (error) {
                console.warn('Embedding generation failed:', error);
            }
            
            return [];
        }

        function displayResumeAnalysis(analysis) {
            let html = '';
            
            if (analysis.error) {
                html = `<div class="error">❌ ${analysis.error}</div>`;
            } else {
                html = `
                    <div><strong>📋 Summary:</strong><br>${analysis.summary || 'Not found'}</div><br>
                    <div><strong>💼 Experience:</strong> ${analysis.experience?.length || 0} positions found</div><br>
                    <div><strong>🛠️ Skills:</strong> ${analysis.skills?.slice(0, 10).join(', ') || 'None found'}</div><br>
                    <div><strong>🎓 Education:</strong> ${analysis.education?.length || 0} entries found</div><br>
                    <div><strong>🏆 Achievements:</strong> ${analysis.achievements?.slice(0, 5).join(', ') || 'None found'}</div><br>
                    <div><strong>🔍 Keywords:</strong> ${analysis.keywords?.slice(0, 10).join(', ') || 'None found'}</div>
                `;
                
                if (analysis.embeddings?.length > 0) {
                    html += `<br><div><strong>🧠 AI Embeddings:</strong> ${analysis.embeddings.length} dimensions generated</div>`;
                }
            }
            
            resumeInsights.innerHTML = html;
        }

        async function performDeepResumeAnalysis() {
            try {
                showAIStatus('🧠 Performing deep AI analysis...', 'info');
                
                const { resumeData } = await chrome.storage.local.get(['resumeData']);
                if (!resumeData) {
                    throw new Error('No resume uploaded');
                }

                // Enhanced analysis using Gemini AI
                const deepAnalysis = await analyzeResumeWithAI(resumeData.content);
                
                // Update stored data
                resumeData.deepAnalysis = deepAnalysis;
                await chrome.storage.local.set({ resumeData });

                // Display enhanced insights
                displayDeepAnalysis(deepAnalysis);
                showAIStatus('✅ Deep analysis completed!', 'success');
                
            } catch (error) {
                console.error('Deep analysis error:', error);
                showAIStatus('❌ Deep analysis failed: ' + error.message, 'error');
            }
        }

        async function analyzeResumeWithAI(resumeText) {
            const prompt = `
                Analyze this resume with deep contextual understanding. Extract:
                1. Core value propositions and unique selling points
                2. Quantifiable achievements with impact metrics
                3. Leadership and team management examples
                4. Technical skills and expertise areas
                5. Industry domain knowledge
                6. Career progression patterns
                7. Problem-solving examples
                8. Innovation and initiative instances
                
                Resume content:
                ${resumeText}
                
                Provide analysis in JSON format with detailed insights for personalized outreach.
            `;

            try {
                const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=YOUR_GEMINI_API_KEY`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({
                        contents: [{
                            parts: [{ text: prompt }]
                        }]
                    })
                });

                if (response.ok) {
                    const data = await response.json();
                    const analysisText = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
                    
                    try {
                        return JSON.parse(analysisText);
                    } catch {
                        return { rawAnalysis: analysisText };
                    }
                } else {
                    throw new Error('AI analysis request failed');
                }
            } catch (error) {
                console.error('AI analysis error:', error);
                throw error;
            }
        }

        function displayDeepAnalysis(deepAnalysis) {
            let html = '<h4>🧠 Deep AI Analysis</h4>';
            
            if (deepAnalysis.rawAnalysis) {
                html += `<div>${deepAnalysis.rawAnalysis}</div>`;
            } else {
                html += `
                    <div><strong>💡 Value Propositions:</strong><br>${Array.isArray(deepAnalysis.valuePropositions) ? deepAnalysis.valuePropositions.join('<br>') : 'Analyzing...'}</div><br>
                    <div><strong>📊 Key Achievements:</strong><br>${Array.isArray(deepAnalysis.achievements) ? deepAnalysis.achievements.join('<br>') : 'Analyzing...'}</div><br>
                    <div><strong>👥 Leadership Examples:</strong><br>${Array.isArray(deepAnalysis.leadership) ? deepAnalysis.leadership.join('<br>') : 'Analyzing...'}</div>
                `;
            }
            
            resumeInsights.innerHTML += '<br><br>' + html;
        }

        async function clearResumeData() {
            try {
                await chrome.storage.local.remove(['resumeData']);
                resumeAnalysis.style.display = 'none';
                resumeInsights.innerHTML = '';
                showAIStatus('🗑️ Resume data cleared', 'info');
            } catch (error) {
                showAIStatus('❌ Error clearing data: ' + error.message, 'error');
            }
        }

        async function loadAIConfiguration() {
            try {
                const { aiConfig } = await chrome.storage.local.get(['aiConfig']);
                if (aiConfig) {
                    personalValue.value = aiConfig.personalValue || '';
                    careerGoals.value = aiConfig.careerGoals || '';
                }
            } catch (error) {
                console.error('Error loading AI config:', error);
            }
        }

        async function saveAIConfiguration() {
            try {
                const aiConfig = {
                    personalValue: personalValue.value.trim(),
                    careerGoals: careerGoals.value.trim(),
                    savedAt: new Date().toISOString()
                };

                await chrome.storage.local.set({ aiConfig });
                showAIStatus('✅ AI configuration saved successfully!', 'success');
            } catch (error) {
                console.error('Error saving AI config:', error);
                showAIStatus('❌ Error saving configuration: ' + error.message, 'error');
            }
        }

        function showAIStatus(message, type) {
            aiStatus.innerHTML = `<div class="status ${type}">${message}</div>`;
            setTimeout(() => {
                aiStatus.innerHTML = '';
            }, 3000);
        }

        // Check if resume already exists
        chrome.storage.local.get(['resumeData']).then(({ resumeData }) => {
            if (resumeData) {
                displayResumeAnalysis(resumeData.analysis);
                resumeAnalysis.style.display = 'block';
                showAIStatus('📄 Resume loaded from storage', 'info');
            }
        });
    }

    // Clean up interval when popup is closed
    window.addEventListener('beforeunload', () => {
        if (statusCheckInterval) {
            clearInterval(statusCheckInterval);
        }
    });
});