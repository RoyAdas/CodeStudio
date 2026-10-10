"""Use the terminal input field to answer, then press Enter."""

try:
    name = input("Your name: ").strip() or "learner"
    print(f"Welcome, {name}!")
    number = int(input("Enter an integer: "))
    print(f"{number} squared is {number * number}")
except EOFError:
    print("Input ended. Run again to try another value.")
except ValueError:
    print("Please run again and enter a valid integer.")
