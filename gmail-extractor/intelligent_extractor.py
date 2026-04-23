import os
import base64
import re
import pickle
from google_auth_oauthlib.flow import InstalledAppFlow
from google.auth.transport.requests import Request
from googleapiclient.discovery import build
import pandas as pd
import spacy
from spacy.language import Language
from typing import Dict, List, Set

# --- CONFIGURATION ---
# Define the scopes for the Gmail API. Readonly is used for safety.
SCOPES = ['https://www.googleapis.com/auth/gmail.readonly']
# File to store the user's access and refresh tokens.
TOKEN_PICKLE_FILE = 'token.pickle'

# --- MODULE 1: GMAIL AUTHENTICATION & COMMUNICATION ---

def get_gmail_service():
    """
    Authenticates with the Gmail API using OAuth 2.0 and returns a service object.
    Handles token creation on the first run and token refresh on subsequent runs.
    """
    creds = None
    # Define the absolute path to your credentials.json file
    credentials_file_path = r"C:\Users\Gaurav Rathore\OneDrive\Desktop\Gmail Email Extractor\credentials.json"

    # The file token.pickle stores the user's access and refresh tokens.
    # It is created automatically when the authorization flow completes for the first time.
    if os.path.exists(TOKEN_PICKLE_FILE):
        with open(TOKEN_PICKLE_FILE, 'rb') as token:
            creds = pickle.load(token)
    # If there are no (valid) credentials available, let the user log in.
    if not creds or not creds.valid:
        if creds and creds.expired and creds.refresh_token:
            creds.refresh(Request())
        else:
            # Check if the credentials.json file exists before attempting to open it
            if not os.path.exists(credentials_file_path):
                print(f"Error: credentials.json not found at '{credentials_file_path}'")
                raise FileNotFoundError(f"credentials.json not found at '{credentials_file_path}'")
            flow = InstalledAppFlow.from_client_secrets_file(credentials_file_path, SCOPES)
            creds = flow.run_local_server(port=0)
        # Save the credentials for the next run
        with open(TOKEN_PICKLE_FILE, 'wb') as token:
            pickle.dump(creds, token)
    
    try:
        service = build('gmail', 'v1', credentials=creds)
        print("Successfully authenticated with Gmail API.")
        return service
    except Exception as e:
        print(f"An error occurred while building the Gmail service: {e}")
        return None

def search_emails(service, query: str) -> List:
    """
    Searches for emails in the user's mailbox using a specific query.
    Handles pagination to retrieve all matching message IDs.
    """
    print(f"Executing search with query: {query}")
    try:
        result = service.users().messages().list(userId='me', q=query).execute()
        messages = []
        if 'messages' in result:
            messages.extend(result['messages'])
        
        # Handle pagination if there are more results
        while 'nextPageToken' in result:
            page_token = result['nextPageToken']
            result = service.users().messages().list(userId='me', q=query, pageToken=page_token).execute()
            if 'messages' in result:
                messages.extend(result['messages'])
        
        print(f"Found {len(messages)} messages matching the query.")
        return messages
    except Exception as e:
        print(f"An error occurred during email search: {e}")
        return []

def get_email_details(service, msg_id: str) -> Dict:
    """
    Fetches the full details of a single email message, including headers and body.
    """
    try:
        # format='full' gets all details including headers and body
        message = service.users().messages().get(userId='me', id=msg_id, format='full').execute()
        return message
    except Exception as e:
        print(f"Could not fetch email with ID {msg_id}: {e}")
        return None

def get_email_body(payload: Dict) -> str:
    """
    Recursively decodes and extracts the plain text body from an email's payload.
    """
    body = ""
    if 'parts' in payload:
        for part in payload['parts']:
            if part.get('mimeType') == 'text/plain' and 'data' in part['body']:
                encoded_body = part['body']['data']
                decoded_body = base64.urlsafe_b64decode(encoded_body).decode('utf-8', errors='ignore')
                body += decoded_body
            # Recurse for multipart messages
            elif 'parts' in part:
                body += get_email_body(part)
    elif 'data' in payload['body']: # Handle non-multipart messages
        encoded_body = payload['body']['data']
        decoded_body = base64.urlsafe_b64decode(encoded_body).decode('utf-8', errors='ignore')
        body += decoded_body
        
    return body

def parse_recipients(headers: List) -> Dict:
    """
    Parses 'To' and 'Cc' headers to extract recipient names and email addresses.
    """
    recipients = {'To': [], 'Cc': []}
    email_regex = re.compile(r'<(.+?)>')
    
    for header in headers:
        header_name = header.get('name', '').lower()
        if header_name in ['to', 'cc']:
            header_value = header.get('value', '')
            # Split recipients, as they can be comma-separated
            for part in header_value.split(','):
                part = part.strip()
                match = email_regex.search(part)
                if match:
                    email = match.group(1)
                    name = part.replace(f"<{email}>", "").strip().replace('"', '')
                else:
                    email = part
                    name = '' # No name part found
                
                recipient_data = {'name': name, 'email': email}
                if header_name == 'to':
                    recipients['To'].append(recipient_data)
                else:
                    recipients['Cc'].append(recipient_data)
    
    return recipients

# --- MODULE 2: INTELLIGENT ENTITY EXTRACTION (NER) ---

class EntityExtractionService:
    """
    A dedicated service for Named Entity Recognition (NER) using spaCy.
    This loads the model once to be reused, improving performance.
    """
    _nlp: Language = None
    _model_name: str = ""

    def __init__(self, model_name: str = "en_core_web_lg"):
        self._model_name = model_name
        try:
            self._nlp = spacy.load(self._model_name)
            print(f"Successfully loaded spaCy model '{self._model_name}'.")
        except OSError:
            print(f"Error: spaCy model '{self._model_name}' not found.")
            print(f"Please run 'python -m spacy download {self._model_name}' to install it.")
            self._nlp = None

    def extract_entities(self, text: str) -> Dict[str, List[str]]:
        """
        Extracts PERSON and ORG entities from text.
        Returns a dictionary with lists of unique persons and organizations.
        """
        if not self._nlp or not text:
            return {"persons": [], "organizations": []}

        doc = self._nlp(text)
        persons: Set[str] = set()
        organizations: Set[str] = set()

        for ent in doc.ents:
            if ent.label_ == "PERSON":
                persons.add(ent.text.strip())
            elif ent.label_ == "ORG":
                organizations.add(ent.text.strip())
        
        return {
            "persons": sorted(list(persons)),
            "organizations": sorted(list(organizations))
        }

# --- MODULE 3: STRATEGIC DATA PROCESSING & OUTPUT ---

def infer_name_from_email(email: str) -> str:
    """A simple heuristic to guess a person's name from their email address."""
    try:
        name_part = email.split('@')[0]
        # Replace common separators with a space and capitalize
        return name_part.replace('.', ' ').replace('_', ' ').title()
    except:
        return ""

def infer_company_from_domain(email: str) -> str:
    """A simple heuristic to guess a company name from an email domain."""
    try:
        domain_part = email.split('@')[1]
        # Remove common TLDs to get the likely company name
        return domain_part.split('.')[0].title()
    except:
        return ""

# --- MAIN EXECUTION ---

def main():
    """
    Main function to orchestrate the email filtering, extraction, and processing.
    """
    # --- USER CONFIGURATION ---
    # Set your filtering criteria here
    SENDER_EMAIL = "your.email@example.com"  # Change this to the specific sender
    SUBJECT_LINE = "Job"  # Change this to the exact subject
    
    # Construct the Gmail search query
    # This query searches for emails from a specific sender, with a specific subject,
    # in either the 'inbox' or 'sent' folders. [2, 3]
    query = f'from:({SENDER_EMAIL}) subject:("{SUBJECT_LINE}") (in:inbox OR in:sent)'

    # 1. Initialize services
    gmail_service = get_gmail_service()
    ner_service = EntityExtractionService()

    if not gmail_service or not ner_service._nlp:
        print("Could not initialize required services. Exiting.")
        return

    # 2. Search for and fetch emails
    message_ids = search_emails(gmail_service, query)
    
    if not message_ids:
        print("No emails found for the specified criteria.")
        return

    all_recipient_data = []
    print("\nProcessing emails and extracting data...")

    # 3. Process each email
    for i, msg_ref in enumerate(message_ids):
        msg_id = msg_ref['id']
        print(f"  Processing email {i+1}/{len(message_ids)} (ID: {msg_id})")
        
        details = get_email_details(gmail_service, msg_id)
        if not details:
            continue

        headers = details['payload']['headers']
        subject = next((h['value'] for h in headers if h['name'].lower() == 'subject'), "No Subject")
        date = next((h['value'] for h in headers if h['name'].lower() == 'date'), "No Date")
        
        # Extract recipients and body content
        recipients = parse_recipients(headers)
        body_text = get_email_body(details['payload'])
        
        # Use NER to extract entities from the body
        entities_in_body = ner_service.extract_entities(body_text)
        persons_in_body = entities_in_body['persons']
        orgs_in_body = entities_in_body['organizations']

        # 4. Create a structured record for each recipient
        combined_recipients = [('To', r) for r in recipients['To']] + [('Cc', r) for r in recipients['Cc']]
        
        for recipient_type, recipient in combined_recipients:
            record = {
                'Message_ID': msg_id,
                'Date': date,
                'Subject': subject,
                'Recipient_Email': recipient['email'],
                'Recipient_Name_From_Header': recipient['name'],
                'Recipient_Type': recipient_type,
                'Inferred_Name_From_Email': infer_name_from_email(recipient['email']),
                'Inferred_Company_From_Domain': infer_company_from_domain(recipient['email']),
                'Mentioned_Persons_In_Body': ", ".join(persons_in_body),
                'Mentioned_Orgs_In_Body': ", ".join(orgs_in_body)
            }
            all_recipient_data.append(record)

    # 5. Create and save the final database (CSV file)
    if not all_recipient_data:
        print("Processing complete, but no recipient data was extracted.")
        return
        
    output_df = pd.DataFrame(all_recipient_data)
    # Remove duplicate rows if the same person was in To and CC of the same email
    output_df.drop_duplicates(inplace=True)
    
    output_filename = "extracted_contacts_database.csv"
    output_df.to_csv(output_filename, index=False, encoding='utf-8')
    
    print(f"\nProcessing complete!")
    print(f"A database of {len(output_df)} records has been saved to '{output_filename}'.")


if __name__ == '__main__':
    main()