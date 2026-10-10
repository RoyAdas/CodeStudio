#include <iostream>
#include <numeric>
#include <vector>

int main() {
    std::cout << "Hello, CodeStudio!\n";
    const std::vector<int> numbers{1, 2, 3, 4, 5};
    const int total = std::accumulate(numbers.begin(), numbers.end(), 0);
    std::cout << "Sum: " << total << '\n';
    return 0;
}
