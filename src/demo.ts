// demo.ts – Scripted LLM for demo mode

import { LlmClient, LlmMessage, LlmOptions, LlmResult } from './llm';

/**
 * Demo mode scripted LLM. Goes through the same parser/validator/executor
 * pipeline as the real client; only replaces the HTTP call.
 */
export class ScriptedLlm implements LlmClient {
  private planReturned = false;

  async complete(messages: LlmMessage[], _opts?: LlmOptions): Promise<LlmResult> {
    // Look at the last user message to determine what state/response to produce
    const lastUser = [...messages].reverse().find(m => m.role === 'user');
    const content = lastUser?.content || '';

    // Detect the state from the prompt content
    if (content.includes('Break it into 3-6 small modules')) {
      return this.planResponse();
    }

    if (content.includes('Write ONE question with exactly 3 plausible options')) {
      return this.askResponse();
    }

    if (content.includes('Write the code for THIS module only')) {
      return this.buildResponse(content);
    }

    if (content.includes('For each thread, write a 1-2 line note')) {
      // Notes: throw controlled error so fallback runs
      throw new Error('Demo mode: notes call intentionally fails for fallback testing');
    }

    if (content.includes('Write a project history update')) {
      // History: throw controlled error so fallback runs
      throw new Error('Demo mode: history call intentionally fails for fallback testing');
    }

    if (content.includes('Answer as a tutor')) {
      return this.chatResponse(content);
    }

    // Default chat response
    return {
      text: '<say>This is demo mode. I can answer questions about the student CLI project, dictionaries, and standard library usage.</say>',
      finishReason: 'stop',
    };
  }

  private planResponse(): LlmResult {
    this.planReturned = true;
    return {
      text: `<say>Here is a plan for a student CLI in Python.</say>
<plan name="Student CLI Management" summary="CLI to add, list and search students.">
<module id="m1" title="Student storage" goal="Store and find students by ID" decision="true" concept="hash map"/>
<module id="m2" title="CLI menu" goal="Loop that reads commands" decision="false" concept=""/>
<module id="m3" title="Age validation" goal="Validate student age on creation" decision="false" concept=""/>
</plan>`,
      finishReason: 'stop',
    };
  }

  private askResponse(): LlmResult {
    return {
      text: `<say>We need fast lookup by student ID.</say>
<ask concept="hash map"><q>Which data structure fits best?</q><opt id="A">List</opt><opt id="B">Dictionary / hash map</opt><opt id="C">Linked list</opt><correct>B</correct><why>A hash map finds an ID in about O(1); a list needs a full scan.</why></ask>`,
      finishReason: 'stop',
    };
  }

  private buildResponse(content: string): LlmResult {
    // Determine which module
    if (content.includes('Student storage') || content.includes('m1')) {
      return this.buildM1();
    }
    if (content.includes('CLI menu') || content.includes('m2')) {
      return this.buildM2();
    }
    if (content.includes('Age validation') || content.includes('m3')) {
      return this.buildM3();
    }
    return this.buildM1();
  }

  private buildM1(): LlmResult {
    return {
      text: `<say>I created the student model and manager. Students are stored in a dictionary keyed by student_id for O(1) lookups.</say>
<folder path="src" purpose="Application source code"/>
<file path="src/models.py" intro="Student class with student_id, name, age, email.">
class Student:
    """Represents a student with basic information."""

    def __init__(self, student_id: str, name: str, age: int, email: str):
        self.student_id = student_id
        self.name = name
        self.age = age
        self.email = email

    def __repr__(self) -> str:
        return f"Student({self.student_id}, {self.name}, age={self.age})"
</file>
<file path="src/student_manager.py" intro="StudentManager with a dict keyed by student_id.">
from models import Student


class StudentManager:
    """Manages students using a dictionary for O(1) lookups."""

    def __init__(self):
        self.students: dict[str, Student] = {}

    def add(self, student: Student) -> bool:
        if student.student_id in self.students:
            return False
        self.students[student.student_id] = student
        return True

    def get(self, student_id: str) -> Student | None:
        return self.students.get(student_id)

    def delete(self, student_id: str) -> bool:
        if student_id in self.students:
            del self.students[student_id]
            return True
        return False

    def list_all(self) -> list[Student]:
        return list(self.students.values())
</file>
<memory>students stored in a dict keyed by student_id for O(1) lookup</memory>`,
      finishReason: 'stop',
    };
  }

  private buildM2(): LlmResult {
    return {
      text: `<say>I created the CLI menu loop. It reads commands and calls StudentManager methods.</say>
<file path="src/main.py" intro="CLI menu loop for student management.">
from models import Student
from student_manager import StudentManager


def main():
    manager = StudentManager()

    while True:
        print("\\n--- Student Manager ---")
        print("1. Add student")
        print("2. Find student")
        print("3. Delete student")
        print("4. List all students")
        print("5. Exit")

        choice = input("Choose an option: ").strip()

        if choice == "1":
            sid = input("Student ID: ").strip()
            name = input("Name: ").strip()
            age = int(input("Age: ").strip())
            email = input("Email: ").strip()
            student = Student(sid, name, age, email)
            if manager.add(student):
                print(f"Added {student}")
            else:
                print("Student ID already exists.")
        elif choice == "2":
            sid = input("Student ID: ").strip()
            student = manager.get(sid)
            if student:
                print(student)
            else:
                print("Student not found.")
        elif choice == "3":
            sid = input("Student ID: ").strip()
            if manager.delete(sid):
                print("Deleted.")
            else:
                print("Student not found.")
        elif choice == "4":
            students = manager.list_all()
            if students:
                for s in students:
                    print(s)
            else:
                print("No students.")
        elif choice == "5":
            print("Goodbye!")
            break
        else:
            print("Invalid option.")


if __name__ == "__main__":
    main()
</file>
<memory>CLI menu loop reads commands and calls StudentManager</memory>`,
      finishReason: 'stop',
    };
  }

  private buildM3(): LlmResult {
    // The find text must occur exactly once in the m1 file content
    return {
      text: `<say>I added age validation to the StudentManager. Ages must be between 1 and 150.</say>
<edit path="src/student_manager.py"><find>    def add(self, student: Student) -> bool:
        if student.student_id in self.students:
            return False
        self.students[student.student_id] = student
        return True</find><replace>    def add(self, student: Student) -> bool:
        if not self._validate_age(student.age):
            raise ValueError(f"Invalid age: {student.age}. Must be between 1 and 150.")
        if student.student_id in self.students:
            return False
        self.students[student.student_id] = student
        return True

    def _validate_age(self, age: int) -> bool:
        return isinstance(age, int) and 1 <= age <= 150</replace></edit>
<memory>age validation: 1-150, raises ValueError</memory>`,
      finishReason: 'stop',
    };
  }

  private chatResponse(content: string): LlmResult {
    const lowerContent = content.toLowerCase();

    if (lowerContent.includes('dict')) {
      return {
        text: `<say>A dictionary (hash map) provides O(1) average-case lookup by key. Since each student has a unique ID, the dictionary maps student_id to the Student object directly.

Alternatives considered:
- List: O(n) search, need to scan every element
- Set: only stores values, not key-value pairs
- Database: better for large-scale or persistent data

For an in-memory CLI tool, a dictionary is the best choice.</say>`,
        finishReason: 'stop',
      };
    }

    if (lowerContent.includes('librar') || lowerContent.includes('requirement')) {
      return {
        text: `<say>The standard library is enough for this project. We use only built-in Python types (dict, list, str, int) and the input/print functions. No external packages are needed.</say>`,
        finishReason: 'stop',
      };
    }

    return {
      text: `<say>This is demo mode with scripted responses. I can answer questions about dictionaries, data structures, and library requirements for the student CLI project.</say>`,
      finishReason: 'stop',
    };
  }
}

/**
 * Get the M1 build content for the demo script (used by tests to verify
 * the edit find text occurs exactly once).
 */
export function getDemoM1FileContent(): string {
  return `from models import Student


class StudentManager:
    """Manages students using a dictionary for O(1) lookups."""

    def __init__(self):
        self.students: dict[str, Student] = {}

    def add(self, student: Student) -> bool:
        if student.student_id in self.students:
            return False
        self.students[student.student_id] = student
        return True

    def get(self, student_id: str) -> Student | None:
        return self.students.get(student_id)

    def delete(self, student_id: str) -> bool:
        if student_id in self.students:
            del self.students[student_id]
            return True
        return False

    def list_all(self) -> list[Student]:
        return list(self.students.values())
`;
}

/**
 * Get the M3 edit find text for verification.
 */
export function getDemoM3FindText(): string {
  return `    def add(self, student: Student) -> bool:
        if student.student_id in self.students:
            return False
        self.students[student.student_id] = student
        return True`;
}
